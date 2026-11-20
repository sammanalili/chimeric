#!/usr/bin/env bun
/**
 * Comprehensive E2E Test Suite Runner for Chimeric Research Workbench.
 *
 * Executes all 4 tiers of tests:
 *   Tier 1: Feature Coverage (205 tests across all 41 features)
 *   Tier 2: Boundary & Corner Cases (205 tests across all 41 features)
 *   Tier 3: Cross-Feature Interactions (41 tests)
 *   Tier 4: Real-World Application Scenarios (21 workflows)
 *
 * Total: 472 test cases.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const CHIMERIC_BIN = process.env.CHIMERIC_BIN || '/Applications/Chimeric.app/Contents/Resources/bin/chimeric';

interface TestSuiteTarget {
  tier: string;
  name: string;
  file: string;
  expectedTests: number;
}

const SUITES: TestSuiteTarget[] = [
  { tier: 'Tier 1', name: 'Features 1-14: Core Workbench, Selection, Connections, SSE & Kernels', file: 'tests/e2e/tier1-part1.test.ts', expectedTests: 70 },
  { tier: 'Tier 1', name: 'Features 15-28: Census, Sandboxing, CAS, Provenance, Viewers, Agents', file: 'tests/e2e/tier1-part2.test.ts', expectedTests: 70 },
  { tier: 'Tier 1', name: 'Features 29-41: Onboarding, Subagents, Branching, Memory, Connectors, Release', file: 'tests/e2e/tier1-part3.test.ts', expectedTests: 65 },
  { tier: 'Tier 2', name: 'Features 1-14: Boundary & Corner Cases', file: 'tests/e2e/tier2-part1.test.ts', expectedTests: 70 },
  { tier: 'Tier 2', name: 'Features 15-28: Boundary & Corner Cases', file: 'tests/e2e/tier2-part2.test.ts', expectedTests: 70 },
  { tier: 'Tier 2', name: 'Features 29-41: Boundary & Corner Cases', file: 'tests/e2e/tier2-part3.test.ts', expectedTests: 65 },
  { tier: 'Tier 3', name: 'Pairwise Cross-Feature Interactions', file: 'tests/e2e/tier3-interactions.test.ts', expectedTests: 41 },
  { tier: 'Tier 4', name: 'Real-World Scientific Research Scenarios', file: 'tests/e2e/tier4-scenarios.test.ts', expectedTests: 21 },
];

console.log('='.repeat(80));
console.log('CHIMERIC RESEARCH WORKBENCH — COMPREHENSIVE E2E TEST SUITE RUNNER');
console.log('='.repeat(80));
console.log(`Root: ${ROOT_DIR}`);
console.log(`Binary: ${CHIMERIC_BIN}`);
console.log(`Planned Suites: ${SUITES.length}`);
console.log(`Expected Total Tests: ${SUITES.reduce((a, b) => a + b.expectedTests, 0)}`);
console.log('-'.repeat(80));

let totalPassed = 0;
let totalFailed = 0;
let totalExpects = 0;
const results: { suite: TestSuiteTarget; passed: number; failed: number; durationMs: number; status: 'PASS' | 'FAIL' }[] = [];

const startTime = Date.now();

for (const suite of SUITES) {
  process.stdout.write(`Running [${suite.tier}] ${suite.name} ... `);
  const suiteStart = Date.now();

  const child = spawnSync(CHIMERIC_BIN, ['test', suite.file], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      BUN_BE_BUN: '1',
    },
    encoding: 'utf-8',
  });

  const durationMs = Date.now() - suiteStart;
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const combined = stdout + '\n' + stderr;

  // Extract pass count: "XX pass"
  const passMatch = combined.match(/(\d+)\s+pass/);
  const failMatch = combined.match(/(\d+)\s+fail/);
  const expectMatch = combined.match(/(\d+)\s+expect\(\)\s+calls/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const expects = expectMatch ? parseInt(expectMatch[1], 10) : 0;

  totalPassed += passed;
  totalFailed += failed;
  totalExpects += expects;

  const isSuccess = child.status === 0 && failed === 0 && passed >= suite.expectedTests;
  results.push({
    suite,
    passed,
    failed,
    durationMs,
    status: isSuccess ? 'PASS' : 'FAIL',
  });

  if (isSuccess) {
    console.log(`\x1b[32mPASS\x1b[0m (${passed}/${suite.expectedTests} tests in ${durationMs}ms)`);
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m (${passed} pass, ${failed} fail in ${durationMs}ms)`);
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
}

const grandDuration = Date.now() - startTime;

console.log('='.repeat(80));
console.log('E2E TEST SUMMARY MATRIX');
console.log('='.repeat(80));
console.log(
  'Tier   | Target Suite                                            | Tests | Status | Time'
);
console.log('-'.repeat(80));
for (const r of results) {
  const tierCol = r.suite.tier.padEnd(6);
  const nameCol = r.suite.name.slice(0, 55).padEnd(55);
  const testsCol = `${r.passed}/${r.suite.expectedTests}`.padStart(5);
  const statusCol = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m  ';
  const timeCol = `${r.durationMs}ms`.padStart(7);
  console.log(`${tierCol} | ${nameCol} | ${testsCol} | ${statusCol} | ${timeCol}`);
}
console.log('-'.repeat(80));
console.log(
  `TOTAL  | Grand Total Across All 4 Tiers                           | ${String(totalPassed).padStart(5)} | ${
    totalFailed === 0 && totalPassed >= 472 ? '\x1b[32mPASS\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m  '
  } | ${grandDuration}ms`
);
console.log(`Total Assertions Checked: ${totalExpects}`);
console.log('='.repeat(80));

if (totalFailed > 0 || totalPassed < 472) {
  console.error(`\x1b[31mTest suite finished with failures: ${totalFailed} failed, ${totalPassed} passed\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[32mAll ${totalPassed} E2E test cases passed cleanly! Zero regressions detected.\x1b[0m`);
  process.exit(0);
}
