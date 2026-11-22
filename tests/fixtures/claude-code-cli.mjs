import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args=JSON.parse(process.env.FIXTURE_ARGS??'[]'),mode=process.env.FIXTURE_MODE??'ok';
const journal=value=>appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify(value)+'\n');
journal({kind:'launch',args,cwd:process.cwd(),pid:process.pid,outputTokenLimit:process.env.FIXTURE_OUTPUT_LIMIT||null});
if(args.includes('auth')){
 if(JSON.stringify(args)!==JSON.stringify(['auth','status','--json']))throw Error('Auth subcommands must not be consumed by variadic inference options');
 process.stdout.write(JSON.stringify({loggedIn:true,authMethod:mode==='api-identity'?'api_key':'claude.ai'})+'\n');
}else if(mode==='hang'||mode==='descendant'){
 if(mode==='descendant'){
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',env:{BUN_BE_BUN:'1'}});journal({kind:'descendant',pid:child.pid});
 }
 setInterval(()=>{},1000);
}else{
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const content=JSON.parse(input).message.content,prompt=typeof content==='string'?content:content.find(block=>block.type==='text').text;journal({kind:'input',prompt,content});
 const transcript=JSON.parse(prompt.slice(prompt.indexOf('\n\n')+2));
 let output=transcript.transcript.some(message=>message.role==='toolResult')?{text:'The tool returned 42.',tool_calls:[]}:
  {text:'I will calculate that.',tool_calls:[{name:'python',arguments_json:JSON.stringify({code:'print(6 * 7)'})}]};
 if(mode==='plain')output={text:'日本語の応答です。',tool_calls:[]};
 if(mode==='vision')output={text:'VISUAL_RESULT',tool_calls:[]};
 if(mode==='unknown-tool')output.tool_calls[0].name='Bash';
 if(mode==='invalid-arguments')output.tool_calls[0].arguments_json='{"code":42}';
 if(mode==='empty')output={text:'',tool_calls:[]};
 if(mode==='malformed')output={text:'hello',tool_calls:[],unexpected:true};
 const model=args[args.indexOf('--model')+1];
 const assistant={type:'assistant',message:{model:mode==='sdk-catalog'?model.replace(/\[1m\]$/,''):mode==='fallback'?'claude-sonnet-fixture':mode==='exact-substitution'?'claude-fable-5-1':model==='claude-fable-5-2'?model:'claude-opus-fixture',content:[{type:'tool_use',name:mode==='builtin'?'Bash':'StructuredOutput',input:output}]}};
 const result={type:'result',subtype:mode==='quota'?'error_during_execution':'success',is_error:mode==='quota',session_id:'fixture-session',structured_output:output,usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:5}};
 if(mode==='context-usage'||mode==='bad-context-usage'||mode==='fractional-context-usage'){
  assistant.message.id='same-assistant-id';assistant.message.usage={input_tokens:mode==='bad-context-usage'?-1:mode==='fractional-context-usage'?0.5:700,output_tokens:1,cache_read_input_tokens:200,cache_creation_input_tokens:100};
  result.usage={input_tokens:10000,output_tokens:200,cache_read_input_tokens:3000,cache_creation_input_tokens:1000};
  result.modelUsage={[assistant.message.model]:{contextWindow:1000000,maxOutputTokens:128000,unexpected:'must not be returned'}};
 }
 if(mode==='quota')result.errors=['synthetic-sensitive-token-must-not-be-returned'];
 if(mode==='bad-json')process.stdout.write('not-json\n');
 else{
  const prior=mode==='context-usage'?JSON.stringify({...assistant,message:{...assistant.message,usage:{input_tokens:9000,output_tokens:1,cache_read_input_tokens:2000,cache_creation_input_tokens:1000}}})+'\n':'';
  const child=mode==='context-usage'?JSON.stringify({...assistant,parent_tool_use_id:'child-tool',message:{...assistant.message,usage:{input_tokens:999999,output_tokens:1,cache_read_input_tokens:999999,cache_creation_input_tokens:999999}}})+'\n':'';
  let text=prior+JSON.stringify(assistant)+'\n'+child+JSON.stringify(result)+'\n';if(mode==='duplicate')text+=JSON.stringify(result)+'\n';
  if(mode==='plain'){
   const bytes=Buffer.from(text);for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
  }else process.stdout.write(text);
 }
}
