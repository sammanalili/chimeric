import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './e2e/test-helpers';
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { BASELINE_URL, getLiveSessionAuth, mintFreshNonce, SessionAuth } from './e2e/test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Adversarial Challenge: Milestone 1 Iteration 3 (Nonce Concurrency, Frame Lifecycle & Model Selection Stress)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;
  let baselineModel: string;
  let reasoningModel: string;
  let nonReasoningModel: string;
  let validReasoningEfforts: string[];
  let invalidReasoningEfforts: string[];

  beforeAll(async () => {
    auth = await getLiveSessionAuth();

    // Query catalog to identify models
    const catRes = await fetch(`${BASELINE_URL}/api/models`, {
      headers: auth.getHeaders('GET'),
    });
    expect(catRes.status).toBe(200);
    const cat = await catRes.json() as any;
    baselineModel = cat.default_model_id;

    const allModels = [
      ...(cat.models?.anthropic ?? []),
      ...(cat.models?.openai ?? []),
      ...(cat.models?.custom ?? []),
    ];

    const foundReasoning = allModels.find(
      (m: any) => m.capabilities?.effort?.supported === true && !m.disabled
    );
    const foundNonReasoning = allModels.find(
      (m: any) => m.capabilities?.effort?.supported === false && !m.disabled
    );

    reasoningModel = foundReasoning?.id ?? 'rikyu::qwen3.6-35b';
    nonReasoningModel = foundNonReasoning?.id ?? 'rikyu::deepseek-v4.1-flash-1017';

    // Extract valid efforts configured for this reasoning model
    const effortOptions = foundReasoning?.thinking?.effort_options ?? [];
    validReasoningEfforts = effortOptions.length > 0
      ? effortOptions.map((o: any) => o.id)
      : ['off', 'low', 'medium', 'high', 'max'];

    // Efforts rejected by this reasoning model
    invalidReasoningEfforts = [
      'minimal',
      'xhigh',
      'super-astronomical',
      'ultra-deep-think',
      'negative-zero',
      '999999',
    ].filter(e => !validReasoningEfforts.includes(e));
  });

  afterAll(async () => {
    // Restore baseline model
    try {
      if (baselineModel && auth) {
        await fetch(`${BASELINE_URL}/api/models/selection`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ model: baselineModel }),
        });
      }
    } catch {}
  });

  // =========================================================================
  // Vector 1: Nonce Minting, Single-Use Exhaustion & Replay Defense Concurrency
  // =========================================================================
  describe('Vector 1: Nonce Minting, Single-Use Exhaustion & Replay Defense Concurrency', () => {
    test('1.1 Concurrent nonce minting generates distinct, valid cryptographic nonces without collisions', async () => {
      const mintCount = 8;
      const mintPromises = Array.from({ length: mintCount }, () => mintFreshNonce());
      const nonces = await Promise.all(mintPromises);

      expect(nonces).toHaveLength(mintCount);
      for (const n of nonces) {
        expect(typeof n).toBe('string');
        expect(n.length).toBeGreaterThanOrEqual(32);
        expect(/^[a-f0-9]+$/i.test(n)).toBe(true);
      }

      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(mintCount);
    });

    test('1.2 Serial redemption and single-use exhaustion: every valid nonce can be used exactly once', async () => {
      const nonce = await mintFreshNonce();

      // First use: must succeed and yield session cookie
      const res1 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce }),
      });
      expect(res1.status).toBe(200);
      const cookie1 = res1.headers.get('set-cookie') || '';
      expect(cookie1).toContain('operon_auth=');

      // Second use (exhausted): must strictly return 401 Unauthorized
      const res2 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce }),
      });
      expect(res2.status).toBe(401);

      // Third use (exhausted again): must still return 401
      const res3 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce }),
      });
      expect(res3.status).toBe(401);
    });

    test('1.3 High-concurrency race replay defense: 20 simultaneous redemptions of a single nonce permit exactly 1 success', async () => {
      const raceNonce = await mintFreshNonce();
      const concurrency = 20;

      const promises = Array.from({ length: concurrency }, () =>
        fetch(`${BASELINE_URL}/api/auth/nonce`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASELINE_URL },
          body: JSON.stringify({ nonce: raceNonce }),
        })
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map(r => r.status);
      const successes = statuses.filter(s => s === 200).length;
      const rejections = statuses.filter(s => s === 401).length;

      expect(successes).toBe(1);
      expect(rejections).toBe(concurrency - 1);

      // Subsequent attempt after race is also strictly 401
      const postRaceRes = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: raceNonce }),
      });
      expect(postRaceRes.status).toBe(401);
    });

    test('1.4 Interleaved multi-nonce barrage: 5 concurrent nonces raced by 3 callers each yield exactly 5 successes and 10 rejections', async () => {
      const nonceCount = 5;
      const callersPerNonce = 3;
      const nonces = await Promise.all(Array.from({ length: nonceCount }, () => mintFreshNonce()));

      const requests: Promise<Response>[] = [];
      for (const n of nonces) {
        for (let c = 0; c < callersPerNonce; c++) {
          requests.push(
            fetch(`${BASELINE_URL}/api/auth/nonce`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', origin: BASELINE_URL },
              body: JSON.stringify({ nonce: n }),
            })
          );
        }
      }

      // Shuffle requests to maximize interleaving
      requests.sort(() => Math.random() - 0.5);

      const responses = await Promise.all(requests);
      const statuses = responses.map(r => r.status);
      const count200 = statuses.filter(s => s === 200).length;
      const count401 = statuses.filter(s => s === 401).length;

      expect(count200).toBe(nonceCount);
      expect(count401).toBe(nonceCount * (callersPerNonce - 1));
    });

    test('1.5 Concurrent mixed redemption: fresh valid nonce succeeds while malicious and malformed nonces are isolated and rejected with 401', async () => {
      const validNonce = await mintFreshNonce();
      const testCases = [
        { nonce: validNonce, expectStatus: 200 },
        { nonce: '', expectStatus: 401 },
        { nonce: '    ', expectStatus: 401 },
        { nonce: '0'.repeat(32), expectStatus: 401 },
        { nonce: 'f'.repeat(64), expectStatus: 401 },
        { nonce: 'non_existent_hex_1234567890abcdef1234', expectStatus: 401 },
        { nonce: '../../etc/passwd', expectStatus: 401 },
        { nonce: randomUUID(), expectStatus: 401 },
        { nonce: 'SELECT * FROM nonces;', expectStatus: 401 },
      ];

      const promises = testCases.map(tc =>
        fetch(`${BASELINE_URL}/api/auth/nonce`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASELINE_URL },
          body: JSON.stringify({ nonce: tc.nonce }),
        })
      );

      const responses = await Promise.all(promises);
      for (let i = 0; i < testCases.length; i++) {
        expect(responses[i].status).toBe(testCases[i].expectStatus);
      }
    });
  });

  // =========================================================================
  // Vector 2: Concurrent Frame Creation & Plan Status Transitions
  // =========================================================================
  describe('Vector 2: Concurrent Frame Creation & Plan Status Transitions', () => {
    test('2.1 High-concurrency frame creation generates distinct frame IDs and survives concurrent deletion', async () => {
      const count = 8;
      const creationPromises = Array.from({ length: count }, () =>
        fetch(`${BASELINE_URL}/api/frames`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
        })
      );

      const createResponses = await Promise.all(creationPromises);
      for (const res of createResponses) {
        expect(res.status).toBe(201);
      }

      const frameData = await Promise.all(createResponses.map(r => r.json() as Promise<any>));
      const frameIds = frameData.map(f => f.root_frame_id);
      expect(new Set(frameIds).size).toBe(count);

      // Verify each created frame concurrently
      const inspectPromises = frameIds.map(id =>
        fetch(`${BASELINE_URL}/api/frames/${id}`, {
          headers: auth.getHeaders('GET'),
        })
      );
      const inspectResponses = await Promise.all(inspectPromises);
      for (const r of inspectResponses) {
        expect(r.status).toBe(200);
      }

      // Concurrently clean up all created frames
      const deletePromises = frameIds.map(id =>
        fetch(`${BASELINE_URL}/api/frames/${id}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        })
      );
      const deleteResponses = await Promise.all(deletePromises);
      for (const r of deleteResponses) {
        expect(r.status).toBeLessThan(300);
      }
    });

    test('2.2 Concurrent plan status transitions on fresh frame strictly enforce guards without race corruption', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;
      const frameId = frame.root_frame_id;

      try {
        // Race 10 concurrent /approve-plan calls: all must return exact 400
        const approvePromises = Array.from({ length: 10 }, () =>
          fetch(`${BASELINE_URL}/api/frames/${frameId}/approve-plan`, {
            method: 'POST',
            headers: auth.getHeaders('POST'),
            body: JSON.stringify({
              edited_plan: { steps: [{ id: 's1', title: 'test', status: 'pending' }] },
            }),
          })
        );
        const approveResponses = await Promise.all(approvePromises);
        for (const res of approveResponses) {
          expect(res.status).toBe(400);
          const body = await res.json() as any;
          expect(body.detail).toContain('Frame has no plan to approve');
        }

        // Race 10 concurrent /discard-plan calls: all must return exact 400
        const discardPromises = Array.from({ length: 10 }, () =>
          fetch(`${BASELINE_URL}/api/frames/${frameId}/discard-plan`, {
            method: 'POST',
            headers: auth.getHeaders('POST'),
            body: JSON.stringify({}),
          })
        );
        const discardResponses = await Promise.all(discardPromises);
        for (const res of discardResponses) {
          expect(res.status).toBe(400);
          const body = await res.json() as any;
          expect(body.detail).toContain('No plan awaiting approval');
        }

        // Race 10 concurrent /resolve-input calls on unparked frame: all must return exact 400
        const resolvePromises = Array.from({ length: 10 }, () =>
          fetch(`${BASELINE_URL}/api/frames/${frameId}/resolve-input`, {
            method: 'POST',
            headers: auth.getHeaders('POST'),
            body: JSON.stringify({
              responses: [{ tool_id: 'tool_test', response: 'ok' }],
            }),
          })
        );
        const resolveResponses = await Promise.all(resolvePromises);
        for (const res of resolveResponses) {
          expect(res.status).toBe(400);
          const body = await res.json() as any;
          expect(body.detail).toContain('Frame not awaiting user response');
        }
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('2.3 Interleaved barrage of racing plan actions (/approve-plan, /discard-plan, /resolve-input) executes with 0 crashes or 500s', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;
      const frameId = frame.root_frame_id;

      try {
        const actions = [
          ...Array.from({ length: 5 }, () =>
            fetch(`${BASELINE_URL}/api/frames/${frameId}/approve-plan`, {
              method: 'POST',
              headers: auth.getHeaders('POST'),
              body: JSON.stringify({ edited_plan: { steps: [] } }),
            })
          ),
          ...Array.from({ length: 5 }, () =>
            fetch(`${BASELINE_URL}/api/frames/${frameId}/discard-plan`, {
              method: 'POST',
              headers: auth.getHeaders('POST'),
              body: JSON.stringify({}),
            })
          ),
          ...Array.from({ length: 5 }, () =>
            fetch(`${BASELINE_URL}/api/frames/${frameId}/resolve-input`, {
              method: 'POST',
              headers: auth.getHeaders('POST'),
              body: JSON.stringify({ responses: [{ tool_id: 'dummy', response: {} }] }),
            })
          ),
        ];

        // Randomize dispatch order
        actions.sort(() => Math.random() - 0.5);

        const results = await Promise.all(actions);
        for (const res of results) {
          expect(res.status).toBe(400);
        }

        // Frame must still be completely healthy and queryable
        const checkRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(checkRes.status).toBe(200);
        const checkFrame = await checkRes.json() as any;
        expect(checkFrame.id).toBe(frameId);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('2.4 Parked frame boundary: concurrent messages blocked with 409 Conflict while plan actions strictly return 400', async () => {
      const parkedFrameId = `${E2E_FIXTURE_IDS.frame}`;

      // Verify frame is parked awaiting input
      const checkParked = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(checkParked.status).toBe(200);
      const parkedData = await checkParked.json() as any;
      expect(parkedData.status).toBe('awaiting_user_response');

      // Race 8 concurrent message sends: all must return 409 Conflict
      const msgPromises = Array.from({ length: 8 }, (_, i) =>
        fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/message`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({ input_data: { text: `Racing message attempt ${i}` } }),
        })
      );
      const msgResponses = await Promise.all(msgPromises);
      for (const res of msgResponses) {
        expect(res.status).toBe(409);
        const err = await res.json() as any;
        expect(err.detail).toContain('is awaiting input — resolve its approval card first.');
      }

      // Race 5 /approve-plan and 5 /discard-plan calls against parked frame without plan awaiting approval
      const planPromises = [
        ...Array.from({ length: 5 }, () =>
          fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/approve-plan`, {
            method: 'POST',
            headers: auth.getHeaders('POST'),
          })
        ),
        ...Array.from({ length: 5 }, () =>
          fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/discard-plan`, {
            method: 'POST',
            headers: auth.getHeaders('POST'),
          })
        ),
      ];
      const planResponses = await Promise.all(planPromises);
      for (const res of planResponses) {
        expect(res.status).toBe(400);
      }

      // Confirm parked frame remains uncorrupted
      const postRaceParked = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(postRaceParked.status).toBe(200);
      const postData = await postRaceParked.json() as any;
      expect(postData.status).toBe('awaiting_user_response');
    });
  });

  // =========================================================================
  // Vector 3: Model Selection Concurrency & Reasoning Effort Options
  // =========================================================================
  describe('Vector 3: Model Selection Concurrency & Reasoning Effort Options', () => {
    test('3.1 Sequential rapid model & effort switching across valid options updates catalog cleanly', async () => {
      for (const effort of validReasoningEfforts) {
        const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ model: reasoningModel, effort }),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.default_model_id).toBe(reasoningModel);
        expect(data.model_selector?.state?.model).toBe(reasoningModel);
        expect(data.model_selector?.state?.thinking?.effort).toBe(effort);
      }

      // Switch to non-reasoning model
      const resNonReasoning = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: nonReasoningModel }),
      });
      expect(resNonReasoning.status).toBe(200);
      const nonReasoningData = await resNonReasoning.json() as any;
      expect(nonReasoningData.default_model_id).toBe(nonReasoningModel);
    });

    test('3.2 High-concurrency barrage: 25 simultaneous model & valid effort selections resolve cleanly without race deadlock', async () => {
      const promises = Array.from({ length: 25 }, (_, idx) => {
        const isReasoning = idx % 2 === 0;
        const targetModel = isReasoning ? reasoningModel : nonReasoningModel;
        const effort = isReasoning
          ? validReasoningEfforts[idx % validReasoningEfforts.length]
          : undefined;
        return fetch(`${BASELINE_URL}/api/models/selection`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ model: targetModel, ...(effort ? { effort } : {}) }),
        });
      });

      const responses = await Promise.all(promises);
      const statuses = responses.map(r => r.status);
      expect(statuses.every(s => s === 200)).toBe(true);

      // Verify catalog consistency after concurrent barrage
      const verifyRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      expect(verifyRes.status).toBe(200);
      const cat = await verifyRes.json() as any;
      expect([reasoningModel, nonReasoningModel]).toContain(cat.default_model_id);
    });

    test('3.3 Concurrent barrage mixing valid selections, invalid reasoning efforts, and phantom models enforces strict boundaries', async () => {
      const phantomModels = ['rikyu::ghost-phantom-1', 'openai::non-existent-99', 'custom::missing-core-model'];
      const requests: { promise: Promise<Response>; expectedStatus: number }[] = [];

      // 10 valid requests
      for (let i = 0; i < 10; i++) {
        const model = i % 2 === 0 ? reasoningModel : nonReasoningModel;
        const effort = i % 2 === 0 ? validReasoningEfforts[0] : undefined;
        requests.push({
          promise: fetch(`${BASELINE_URL}/api/models/selection`, {
            method: 'PUT',
            headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
            body: JSON.stringify({ model, ...(effort ? { effort } : {}) }),
          }),
          expectedStatus: 200,
        });
      }

      // Invalid reasoning efforts against reasoning model -> 400
      for (const badEffort of invalidReasoningEfforts) {
        requests.push({
          promise: fetch(`${BASELINE_URL}/api/models/selection`, {
            method: 'PUT',
            headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
            body: JSON.stringify({ model: reasoningModel, effort: badEffort }),
          }),
          expectedStatus: 400,
        });
      }

      // Phantom/unavailable models -> 400
      for (const badModel of phantomModels) {
        requests.push({
          promise: fetch(`${BASELINE_URL}/api/models/selection`, {
            method: 'PUT',
            headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
            body: JSON.stringify({ model: badModel }),
          }),
          expectedStatus: 400,
        });
      }

      // Non-reasoning models with arbitrary effort -> 200 (ignored gracefully)
      for (const arbitraryEffort of ['irrelevant_effort_1', 'irrelevant_effort_2']) {
        requests.push({
          promise: fetch(`${BASELINE_URL}/api/models/selection`, {
            method: 'PUT',
            headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
            body: JSON.stringify({ model: nonReasoningModel, effort: arbitraryEffort }),
          }),
          expectedStatus: 200,
        });
      }

      // Shuffle execution order
      requests.sort(() => Math.random() - 0.5);

      const responses = await Promise.all(requests.map(r => r.promise));
      for (let i = 0; i < requests.length; i++) {
        expect(responses[i].status).toBe(requests[i].expectedStatus);
      }

      // Verify daemon health and restore baseline model
      const restoreRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: baselineModel }),
      });
      expect(restoreRes.status).toBe(200);

      const finalCatRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      expect(finalCatRes.status).toBe(200);
      const finalCat = await finalCatRes.json() as any;
      expect(finalCat.default_model_id).toBe(baselineModel);
    });
  });
});
