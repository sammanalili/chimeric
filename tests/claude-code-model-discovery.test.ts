import {test,expect} from 'bun:test';
import {discoverClaudeCodeModels,normalizeClaudeCodeModels} from '../src/claude-code-model-discovery';
const raw=()=>[
 {value:'default',displayName:'Default (recommended)',resolvedModel:'claude-opus-7-2',supportsEffort:true,supportedEffortLevels:['low','medium','high','xhigh','max'],supportsAdaptiveThinking:true},
 {value:'opus',displayName:'Opus',resolvedModel:'claude-opus-7-2',supportsEffort:true,supportedEffortLevels:['low','high']},
 {value:'claude-fable-5-2[1m]',displayName:'Fable',resolvedModel:'claude-fable-5-2',supportsEffort:true,supportedEffortLevels:['medium','high']},
 {value:'haiku',displayName:'Haiku',resolvedModel:'claude-haiku-7-2',supportsEffort:false},
];
test('catalog names and supported efforts come from official metadata while saved context-variant IDs remain stable',()=>{
 const models=normalizeClaudeCodeModels(raw());
 expect(models.map(model=>model.name)).toEqual(['Default (Opus 7.2)','Opus 7.2','Fable 5.2','Haiku 7.2']);
 expect(models[1].reasoningEfforts).toEqual({low:'low',high:'high'});
 expect(models[2]).toMatchObject({id:'claude-fable-5-2',transportId:'claude-fable-5-2[1m]',resolvedModel:'claude-fable-5-2',contextWindow:1_000_000});
 expect(models[3]).toMatchObject({reasoning:false,reasoningEfforts:{},reasoningEffortsVerified:true});
 expect(normalizeClaudeCodeModels([{value:'future',displayName:'Future client label',resolvedModel:'unknown-client-model'}])[0].name).toBe('Future client label');
});
test('disabled models are omitted and duplicate context variants prefer the exact advertised base ID',()=>{
 const context=raw()[2];
 const models=normalizeClaudeCodeModels([context,{...context,value:'claude-fable-5-2'},{value:'blocked',displayName:'Blocked',disabled:true}]);
 expect(models).toHaveLength(1);expect(models[0].transportId).toBe('claude-fable-5-2');
 for(const bad of [[],[{value:'--malicious',displayName:'Bad'}],[{value:'opus',displayName:'Bad\nname'}],[{...raw()[0],supportedEffortLevels:['ultra']}],[raw()[0],raw()[0]]])expect(()=>normalizeClaudeCodeModels(bad)).toThrow();
});
test('reviewed resolved models supply documented context and output limits for every subscription alias',()=>{
 const aliases=[['default','claude-opus-5-5'],['opus','claude-opus-5-5'],['sonnet','claude-sonnet-5-5'],['haiku','claude-haiku-5-5'],['claude-fable-5-2[1m]','claude-fable-5-2']];
 const models=normalizeClaudeCodeModels(aliases.map(([value,resolvedModel])=>({value,resolvedModel,displayName:value})));
 expect(models).toHaveLength(5);
 for(const model of models)expect(model).toMatchObject({contextWindow:1_000_000,max_input_tokens:1_000_000,max_output_tokens:128_000,input:['text','image'],verified:false});
 expect(models[0].id).toBe('default');expect(models[4].transportId).toBe('claude-fable-5-2[1m]');
 // Exact published IDs are also authoritative when an alias is not involved.
 expect(normalizeClaudeCodeModels([{value:'claude-sonnet-5-5',displayName:'Sonnet'}])[0]).toMatchObject({max_input_tokens:1_000_000,max_output_tokens:128_000});
});
test('explicit client or account token limits override reviewed defaults without guessing limits for other models',()=>{
 const models=normalizeClaudeCodeModels([
  {value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus',contextWindow:200_000,maxOutputTokens:8_192},
  {value:'custom',resolvedModel:'custom-model',displayName:'Custom',max_input_tokens:200_000,max_output_tokens:32_000},
  {value:'bounded',displayName:'Bounded',contextWindow:1_000_000,maxInputTokens:200_000,maxContextWindowTokens:500_000},
  {value:'future',resolvedModel:'claude-opus-7-2',displayName:'Future'},
  {value:'legacy',resolvedModel:'claude-haiku-4-5-20251001',displayName:'Legacy'},
  {value:'unresolved',displayName:'Opus 5.5'},
  {value:'claude-future-7-2[1m]',displayName:'Explicit 1M variant'},
 ]);
 expect(models[0]).toMatchObject({contextWindow:200_000,max_input_tokens:200_000,max_output_tokens:8_192});
 expect(models[1]).toMatchObject({contextWindow:200_000,max_input_tokens:200_000,max_output_tokens:32_000});
 expect(models[2]).toMatchObject({contextWindow:200_000,max_input_tokens:200_000});
 for(const model of models.slice(3,6)){expect(model.contextWindow).toBeUndefined();expect(model.max_input_tokens).toBeUndefined();expect(model.max_output_tokens).toBeUndefined();expect(model.input).toEqual(['text'])}
 expect(models[6]).toMatchObject({id:'claude-future-7-2',contextWindow:1_000_000,max_input_tokens:1_000_000});expect(models[6].max_output_tokens).toBeUndefined();
});
test('malformed explicit token limits are rejected rather than replaced with larger reviewed defaults',()=>{
 for(const field of ['contextWindow','maxContextWindowTokens','max_input_tokens','maxInputTokens','context_length','max_output_tokens','maxOutputTokens']){
  for(const value of [0,-1,1.5,Infinity,NaN,100_000_001,'200000',null])expect(()=>normalizeClaudeCodeModels([{value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus',[field]:value}])).toThrow('token limits');
 }
});
test('metadata-only discovery sends only initialize, disables runtime customization and discards account data',async()=>{
 const commands:any[]=[];
 const models=await discoverClaudeCodeModels({},new AbortController().signal,(async(_options,args,input)=>{
  commands.push(args);const request=JSON.parse(input!);
  expect(request).toMatchObject({type:'control_request',request:{subtype:'initialize',hooks:{},sdkMcpServers:[]}});
  expect(input!.trim().split('\n')).toHaveLength(1);
  expect(args).toContain('--await-initialize');expect(args).toContain('--safe-mode');expect(args).toContain('--restricted');expect(args).toContain('--strict-mcp-config');expect(args[args.indexOf('--tools')+1]).toBe('');
  expect(args.indexOf('--print')).toBeGreaterThan(args.indexOf('--disallowedTools'));
  expect(args).not.toContain('--dangerously-skip-permissions');
  return {code:0,stderr:'',stdout:JSON.stringify({type:'system',subtype:'init'})+'\n'+JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:raw(),account:{email:'private-fixture@example.test',organization:'private-fixture'}}}})+'\n'};
 }) as any);
 expect(commands).toHaveLength(1);expect(JSON.stringify(models)).not.toContain('private-fixture');expect(models).toHaveLength(4);
});
for(const mode of ['missing','wrong-id','error','duplicate','assistant','result','malformed','oversized'])test('discovery rejects '+mode+' without issuing a model prompt or retry',async()=>{
 let calls=0;
 await expect(discoverClaudeCodeModels({},new AbortController().signal,(async(_options:any,_args:any,input:any)=>{
  calls++;const request=JSON.parse(input),message={type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:raw()}}};
  let stdout=JSON.stringify(message)+'\n';
  if(mode==='missing')stdout='';
  if(mode==='wrong-id')stdout=JSON.stringify({...message,response:{...message.response,request_id:'foreign'}});
  if(mode==='error')stdout=JSON.stringify({...message,response:{...message.response,subtype:'error'}});
  if(mode==='duplicate')stdout+=stdout;
  if(mode==='assistant'||mode==='result')stdout=JSON.stringify({type:mode})+'\n'+stdout;
  if(mode==='malformed')stdout='invalid json';
  if(mode==='oversized')stdout=' '.repeat(1024*1024+1);
  return {code:0,stdout,stderr:''};
 }) as any)).rejects.toThrow();expect(calls).toBe(1);
});
