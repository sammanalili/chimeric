import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../src/registry';

test('compatible catalogs expose advertised image outputs and dedicated image-model candidates without provider-specific rules',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-image-output-'));
 try{
  const registry=new Registry({providers:{compatible:{name:'Compatible endpoint',api:'openai-completions',baseUrl:'https://compatible.example.invalid/v1',models:[{id:'catalog-image',output_modalities:['text','image']},{id:'ImageGenator'},{id:'ordinary-chat'}]}},defaultModel:'compatible::ordinary-chat'},dir);
  await registry.refresh(false);
  expect(registry.models.get('compatible::catalog-image')).toMatchObject({imageGenerationCandidate:true,imageGenerationAdvertised:true});
  expect(registry.models.get('compatible::ImageGenator')).toMatchObject({imageGenerationCandidate:true,imageGenerationAdvertised:false});
  expect(registry.models.get('compatible::ordinary-chat')?.imageGenerationCandidate).toBeUndefined();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
