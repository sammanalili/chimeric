import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReplayStore,toContext,toNativeContent} from '../src/protocol';
import {ContentReader} from '../src/content';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const close of cleanup.splice(0))close()});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'chimeric-fable-history-'));const store=new ReplayStore(join(dir,'replay.db')),reader=new ContentReader(join(dir,'documents'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return {store,reader}}
const model:any={id:'claude-fable-5-2',qualifiedId:'fixture::claude-fable-5-2',replayKey:'fixture::claude-fable-5-2@credential-A',api:'anthropic-messages',provider:'fixture',input:['text','image']};
const signed=(signature:string)=>[{type:'thinking',thinking:'',signature},{type:'text',text:'OK'}];
test('Fable replay distinguishes signed histories with identical visible text',()=>{
 const {store}=fixture(),a:any={content:[{type:'thinking',thinking:'',thinkingSignature:'synthetic-A'}]},b:any={content:[{type:'thinking',thinking:'',thinkingSignature:'synthetic-B'}]};
 store.put(signed('synthetic-A'),model.replayKey,a);store.put(signed('synthetic-B'),model.replayKey,b);
 expect(store.get(signed('synthetic-A'),model.replayKey)).toEqual(a);expect(store.get(signed('synthetic-B'),model.replayKey)).toEqual(b);
});
test('Fable cache miss stops when original effort and prefix metadata cannot be recovered',async()=>{
 const {store,reader}=fixture();await expect(toContext({messages:[{role:'user',content:'Start'},{role:'assistant',content:signed('synthetic-history')},{role:'user',content:'Next'}]},model,reader,store)).rejects.toMatchObject({httpStatus:400});
});
test('Missing or placeholder Fable signatures stop before provider dispatch',async()=>{
 const {store,reader}=fixture();for(const signature of [undefined,'','local-provider-replay'])await expect(toContext({messages:[{role:'assistant',content:signed(signature as any)},{role:'user',content:'Next'}]},model,reader,store)).rejects.toMatchObject({httpStatus:400});
});
test('Encrypted redacted thinking survives without becoming visible text',async()=>{
 const {store,reader}=fixture(),blocks=[{type:'redacted_thinking',data:'synthetic-encrypted-history'},{type:'text',text:'OK'}];
 store.put(blocks,model.replayKey,{role:'assistant',api:'anthropic-messages',provider:'fixture',model:model.id,content:[{type:'thinking',redacted:true,thinking:'',thinkingSignature:'synthetic-encrypted-history'},{type:'text',text:'OK'}],providerThinkingLevel:'high'} as any);
 const result=await toContext({messages:[{role:'assistant',content:blocks},{role:'user',content:'Next'}]},model,reader,store);const assistant=result.messages.find(message=>message.role==='assistant')!;
 expect(toNativeContent(assistant as any)).toEqual(blocks);expect((assistant.content as any)[0]).toMatchObject({redacted:true,thinking:''});
});
