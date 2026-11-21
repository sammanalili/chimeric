import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from '@babel/parser';
import {nativeUploadContextEdits,type NativeUploadEdit} from '../tools/native-upload-context';

const archive=resolve(import.meta.dir,'../../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz'),nativeTest=existsSync(archive)?test:test.skip;
function original(file:string){const result=Bun.spawnSync(['/usr/bin/tar','-xOf',archive,'./web-dist/assets/'+file],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode).toBe(0);return result.stdout.toString()}
function apply(source:string,edits:NativeUploadEdit[]){for(const edit of [...edits].sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);return source}

nativeTest('saved composer uploads carry the active root through normal, chunked, cancel and EIPC paths',()=>{
 const apiSource=original('index-BgpYmw3d.js'),apiEdits=nativeUploadContextEdits(parse(apiSource,{sourceType:'module'}),apiSource,'index-BgpYmw3d.js'),api=apply(apiSource,apiEdits);
 expect(apiEdits.map(edit=>edit.label).sort()).toEqual(['native-upload-api-frame','native-upload-chunks-frame']);expect(()=>parse(api,{sourceType:'module'})).not.toThrow();
 expect(api).toContain('uploadProjectAttachment(t,n,r=!1,s,o,chimericFrameId)');
 expect(api).toContain('frame_id:chimericFrameId');expect(api).toContain('_uploadProjectAttachmentChunked(t,n,s,o,chimericFrameId)');
 expect(api).toContain('c.searchParams.set("frameId",chimericFrameId)');expect(api).toContain('chimericUploadUrl(h)');expect(api).toContain('chimericUploadUrl(`/artifacts/upload/${ze(l)}`)');
 const actionSource=original('useSessionActions-B0Qf6PUm.js'),actionEdits=nativeUploadContextEdits(parse(actionSource,{sourceType:'module'}),actionSource,'useSessionActions-B0Qf6PUm.js'),actions=apply(actionSource,actionEdits);
 expect(actionEdits.map(edit=>edit.label)).toEqual(['native-composer-upload-frame']);expect(()=>parse(actions,{sourceType:'module'})).not.toThrow();expect(actions).toContain('g.uploadProjectAttachment(e,t,n,r,d,a)');
});

nativeTest('upload patch rejects duplicate application and unrecognized boundaries',()=>{
 for(const file of ['index-BgpYmw3d.js','useSessionActions-B0Qf6PUm.js']){const source=original(file),patched=apply(source,nativeUploadContextEdits(parse(source,{sourceType:'module'}),source,file));expect(()=>nativeUploadContextEdits(parse(patched,{sourceType:'module'}),patched,file)).toThrow('boundary changed')}
 expect(nativeUploadContextEdits(parse('export const untouched=1',{sourceType:'module'}),'export const untouched=1','other.js')).toEqual([]);
});
