import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {dispatchModel} from './model-dispatch';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Registry, withModelReplayKey } from './registry';
import { ContentReader } from './content';
import { ReplayStore, toContext, nativeMessage, messageContextUsage, stopReason, toolChoice, toNativeContent } from './protocol';
import { localServerTool, executeServerTool } from './server-tools';
import {defaultEffort,modelEfforts} from './model-effort';
import {FABLE_5_2_ID,anthropicConfigurationError} from './anthropic-compat';
const replayControls = new WeakMap<object,ReplayStore>();
export function clearBridgeReplay(server: object) { replayControls.get(server)?.clear(); }

function providerFailure(event: any, api: string): Error {
  const error = new Error(event.error.errorMessage ?? event.reason);
  // Keep the upstream status structured. Matching words in an error message
  // could turn an unrelated transient failure into a permanent one.
  const status = event.error.httpStatus;
  if (['antigravity-http','anthropic-messages'].includes(api) && Number.isInteger(status) && status >= 400 && status <= 599) {
    Object.assign(error, { httpStatus: status });
  }
  return error;
}

function streamErrorType(error: any): string {
  // The native consumer retries api_error events. Invalid requests, expired
  // credentials, permission denials and quota responses need user action.
  const status = error?.httpStatus;
  if (!Number.isInteger(status) || status < 400 || status >= 500) return 'api_error';
  // Native rate_limit_error events retry indefinitely. AGY requires an explicit
  // stop-and-wait on 429, so use the terminal request category and retain the
  // provider's quota/Retry-After explanation in the message.
  return ({401:'authentication_error',403:'permission_error',404:'not_found_error'} as Record<number,string>)[status] ?? 'invalid_request_error';
}

export type BridgeAuthorization={modelId:string;replayNamespace?:string;signal?:AbortSignal;assertCurrent:()=>void|Promise<void>;close:()=>void;executeServerTool?:typeof executeServerTool};
export type BridgePolicy={authorize:(request:Request,body:any)=>Promise<BridgeAuthorization>};
export function startBridge(registry: Registry, token: string, port = 0, serverToolExecutor = executeServerTool, policy?:BridgePolicy) {
  const directory = join(registry.profileDir, 'provider'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reader = new ContentReader(join(directory, 'documents'));
  const replay = new ReplayStore(join(directory, 'replay.db'));
  const audit = (event: any) => appendFileSync(join(directory, 'requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 255, maxRequestBodySize: 80 * 1024 * 1024,
    async fetch(request) {
      const supplied = request.headers.get('x-api-key') ?? request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return Response.json({ error: { type: 'authentication_error', message: 'Invalid local provider session' } }, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === '/local/catalog') return Response.json(registry.snapshot());
      let authorization:BridgeAuthorization|undefined;
      try {
        const body = await request.json() as any;
        if (path === '/local/select') return Response.json(registry.select(body.model ?? registry.state.model, body.effort));
        if (path.endsWith('/messages/count_tokens')) return Response.json({ input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body),'utf8') / 3), token_count_source: 'byte-estimate' });
        if (!path.endsWith('/messages')) return Response.json({ error: { type: 'not_found_error', message: 'Unknown local provider route' } }, { status: 404 });
        authorization=await policy?.authorize(request,body);
        if(authorization)body.model=authorization.modelId;
        await authorization?.assertCurrent();
        let model = registry.resolve(body.model);
        if(authorization?.replayNamespace)model=withModelReplayKey(model,(model.replayKey??model.qualifiedId)+'@native-root:'+authorization.replayNamespace);
        if(model.api==='anthropic-messages'&&model.id===FABLE_5_2_ID&&(body.thinking?.type==='disabled'||body.thinking?.type==='enabled'||body.output_config?.effort==='off'))throw anthropicConfigurationError('Claude Fable 5.2 requires adaptive thinking and does not support thinking off or manual thinking budgets.');
        const cancel=new AbortController(),policySignal=AbortSignal.any([request.signal,cancel.signal,...authorization?.signal?[authorization.signal]:[]]);
        const {sessionScope,...auth}=await registry.requestAuth(model,policySignal);
        policySignal.throwIfAborted();await authorization?.assertCurrent();
        const usageBinding=registry.usage?.captureBinding(model.provider);
        if(sessionScope)model=withModelReplayKey(model,model.replayKey+'@'+sessionScope);
        const localTools = new Set<string>();
        const converted = { ...body, tools: (body.tools ?? []).map((t: any) => {
          const local = localServerTool(t); if (local) { localTools.add(t.name); return local; } return t;
        }) };
        const signal=AbortSignal.any([policySignal,...auth.signal?[auth.signal]:[]]);
        const context = await toContext(converted, model, reader, replay, signal);
        signal.throwIfAborted();await authorization?.assertCurrent();
        const id = 'msg_local_' + randomUUID().replaceAll('-', '');
        const requestedAt = Date.now();
        audit({ event: 'start', id, requestedModel: body.model, provider: model.provider, model: model.id, api: model.api, tools: context.tools?.map(t => t.name) });
        const run = async (emit: (type: string, data: any) => void) => {
          const blocks: any[] = []; let offset = 0; let final: any; let totalInput = 0, totalOutput = 0;
          emit('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
          for (let round = 0; round < 12; round++) {
            signal.throwIfAborted();await authorization?.assertCurrent();
            const fn = (m:any,c:any,o:any)=>dispatchModel(m,c,o,registry);
            let choice = context.tools?.length ? round === 0 ? toolChoice(body) : 'auto' : undefined;
            if (['openai-responses','openai-codex-responses'].includes(model.api) && typeof choice === 'object') choice = { type: 'function', name: choice.function.name };
            const requestedEffort=body.output_config?.effort;
            const effort = body.thinking?.type === 'disabled' || requestedEffort === 'off' ? undefined : modelEfforts(model).includes(requestedEffort)?requestedEffort:defaultEffort(model);
            const reasoning = model.reasoning && ['minimal','low','medium','high','xhigh','max'].includes(effort) ? {reasoningEffort:effort} : {};
            const events = fn(model as any, normalizeContext(context), { ...auth, transport:'sse', signal, maxTokens: Math.min(body.max_tokens ?? model.maxTokens, model.maxTokens), ...(body.temperature !== undefined && model.api!=='openai-codex-responses' ? { temperature: body.temperature } : {}), ...reasoning, toolChoice: choice as any, maxRetries: 0, timeoutMs: model.requestTimeoutMs,
              onResponse(response:any){try{registry.usage?.observeHeaders(model,response.headers,usageBinding)}catch{/* Metrics must not interrupt research. */}},
              onPayload(payload:any) {
                if(model.reasoning && model.api === 'openai-completions' && model.compat?.supportsReasoningEffort !== false && effort) payload.reasoning_effort=effort;
                audit({event:'provider_settings',id,model:model.id,api:model.api,reasoningEffort:payload.reasoning_effort??payload.reasoning?.effort??null,enableThinking:payload.chat_template_kwargs?.enable_thinking??payload.enable_thinking??payload.thinking?.type??null});
                return payload;
              },
            });
            const opened = new Map<number, number>(); const closed = new Set<number>(); const toolJson = new Map<number,string>();
            const begin = (event: any) => {
              if (opened.has(event.contentIndex)) return opened.get(event.contentIndex)!;
              const index = offset + event.contentIndex; const b = event.partial.content[event.contentIndex];
              let block: any;
              if (b.type === 'text') block = { type: 'text', text: '' };
              else if (b.type === 'thinking') block = b.redacted?{type:'redacted_thinking',data:b.thinkingSignature}:{ type: 'thinking', thinking: '', signature: '' };
              else block = { type: localTools.has(b.name) ? 'server_tool_use' : 'tool_use', id: b.id, name: b.name, input: {} };
              opened.set(event.contentIndex, index); emit('content_block_start', { type: 'content_block_start', index, content_block: block }); return index;
            };
            for await (const event of events) {
              if (event.type.endsWith('_start') && 'contentIndex' in event) begin(event);
              else if (event.type.endsWith('_delta') && 'contentIndex' in event) {
                const index = begin(event); const delta = event.type === 'text_delta' ? { type: 'text_delta', text: event.delta } : event.type === 'thinking_delta' ? { type: 'thinking_delta', thinking: event.delta } : { type: 'input_json_delta', partial_json: event.delta };
                if (event.type === 'toolcall_delta') toolJson.set(event.contentIndex,(toolJson.get(event.contentIndex) ?? '')+event.delta);
                emit('content_block_delta', { type: 'content_block_delta', index, delta });
              } else if (event.type.endsWith('_end') && 'contentIndex' in event) {
                const index = begin(event);
                if (event.type === 'toolcall_end' && !toolJson.get(event.contentIndex)) emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(event.toolCall.arguments)}});
                if (event.type === 'thinking_end'&&!event.partial.content[event.contentIndex]?.redacted) emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: event.partial.content[event.contentIndex]?.thinkingSignature??'local-provider-replay' } });
                emit('content_block_stop', { type: 'content_block_stop', index }); closed.add(index);
              } else if (event.type === 'done') final = event.message;
              else if (event.type === 'error') throw providerFailure(event, model.api);
            }
            await authorization?.assertCurrent();
            if (!final) throw new Error('Provider closed without a completed message');
            try{registry.usage?.record(model,final.usage,id+':'+round,usageBinding)}catch{/* Metrics must not interrupt research. */}
            for (const index of opened.values()) if (!closed.has(index)) emit('content_block_stop', { type: 'content_block_stop', index });
            totalInput += final.usage.input; totalOutput += final.usage.output;
            const native = toNativeContent(final); replay.put(native, model.replayKey??model.qualifiedId, final);
            blocks.push(...native.map((b: any) => b.type === 'tool_use' && localTools.has(b.name) ? { ...b, type: 'server_tool_use' } : b));
            offset += final.content.length;
            const serverCalls = final.content.filter((b: any) => b.type === 'toolCall' && localTools.has(b.name));
            if (!serverCalls.length) break;
            const hasNativeCalls = final.content.some((b: any) => b.type === 'toolCall' && !localTools.has(b.name));
            context.messages.push(final);
            for (const call of serverCalls) {
              let result: any; let isError = false;
              try { await authorization?.assertCurrent();result = await (authorization?.executeServerTool??serverToolExecutor)(call.name, call.arguments, registry.config.searchUrl, signal); }
              catch (e) { isError = true; result = { error: registry.safeError(e) }; }
              const text = JSON.stringify(result);
              context.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError, timestamp: Date.now() });
              const content = call.name === 'web_search'
                ? isError ? {type:'web_search_tool_result_error',error_code:'unavailable'} : result.results.map((r:any)=>({type:'web_search_result',url:r.url,title:r.title,encrypted_content:'local:'+Buffer.from(JSON.stringify(r)).toString('base64')}))
                : isError ? {type:'web_fetch_tool_result_error',error_code:'unavailable'} : {type:'web_fetch_result',url:result.url,retrieved_at:new Date().toISOString(),content:{type:'document',title:result.url,source:{type:'text',media_type:'text/plain',data:result.text}}};
              const block = { type: call.name + '_tool_result', tool_use_id: call.id, content, is_error: isError };
              blocks.push(block); emit('content_block_start', { type: 'content_block_start', index: offset, content_block: block }); emit('content_block_stop', { type: 'content_block_stop', index: offset++ });
            }
            if (hasNativeCalls) break;
            final = undefined;
          }
          if (!final) throw new Error('Local server-tool round limit reached');
          const message = nativeMessage(final, body.model, id); message.content = blocks;
          // A CLI can consume several provider requests to produce this one
          // native turn. Its last request describes the occupied context;
          // summing billed inputs would make the native compactor fire early.
          // Accounting above and the audit below keep the aggregate spend.
          if(!messageContextUsage(final))message.usage = { ...message.usage, input_tokens: totalInput, output_tokens: totalOutput };
          emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(final.stopReason), stop_sequence: null }, usage: message.usage });
          emit('message_stop', { type: 'message_stop' });
          audit({ event: 'complete', id, provider: model.provider, model: model.id, durationMs: Date.now() - requestedAt, inputTokens: totalInput, outputTokens: totalOutput, toolCalls: blocks.filter(b => b.type.endsWith('tool_use')).map(b => b.name) });
          return message;
        };
        if (!body.stream) {try{return Response.json(await run(() => {}))}finally{authorization?.close()}}
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const emit = (event: string, data: any) => { if (!signal.aborted) controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')); };
            const timer = setInterval(() => emit('ping', { type: 'ping' }), 15_000);
            run(emit).catch(error => { audit({ event: 'error', id, error: registry.safeError(error) }); emit('error', { type: 'error', error: { type: streamErrorType(error), message: registry.safeError(error) } }); }).finally(() => { authorization?.close();clearInterval(timer); try { controller.close(); } catch {} });
          }, cancel() { cancel.abort(new Error('Native client cancelled')); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': id } });
      } catch (error:any) { authorization?.close();return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: registry.safeError(error) } }, { status: Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:400 }); }
    },
  });
  replayControls.set(server,replay);
  return server;
}
