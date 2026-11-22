import {test,expect} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parse} from '@babel/parser';

const root=resolve(import.meta.dir,'..');
const original=resolve(root,'../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz');
// macOS ships an older Python ahead of Homebrew on some development PATHs.
// Match the archive builder's existing safe-extraction requirement.
const python=process.env.CHIMERIC_PYTHON??['python3.14','python3.13','python3.12','python3.11','python3'].map(name=>Bun.which(name)).find(path=>path&&Bun.spawnSync([path,'-c','import tarfile; raise SystemExit(0 if hasattr(tarfile,"data_filter") else 1)'],{stdout:'ignore',stderr:'ignore'}).exitCode===0);

(existsSync(original)?test:test.skip)('the built native Connections panel mounts models, images and optional classifiers and includes four generic skills',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chimeric-connections-frontend-'));
 try{
  const destination=join(directory,'assets.tar.gz');
  if(!python)throw Error('The frontend archive fixture requires Python with tarfile.data_filter. Set CHIMERIC_PYTHON to its executable.');
  const result=Bun.spawnSync([python,join(root,'tools/build-frontend.py'),original,destination,process.execPath],{cwd:root,env:{...process.env,BUN_BE_BUN:'1'},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode,result.stderr.toString()).toBe(0);
  const manifest=JSON.parse(readFileSync(join(directory,'asset-manifest.json'),'utf8'));
  const binding=Bun.spawnSync([python,'-c','import importlib.util,sys;from pathlib import Path;s=importlib.util.spec_from_file_location("portable",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m._validate_archive_binding(Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4])',join(root,'tools/build-portable.py'),destination,manifest.root,manifest.sha256],{stdout:'pipe',stderr:'pipe'});
  expect(binding.exitCode,binding.stderr.toString()).toBe(0);
  const component=readFileSync(join(manifest.root,'web-dist/assets/index-DXq2yXE0.js'),'utf8');
  const program=parse(component,{sourceType:'module'}).program;
  expect(component).toContain('"data-testid":"chimeric-connections"');
  expect(component).toContain('title:tr("Connections")');
  // The original generic secret directory was not a model-connection UI and
  // must not remain available behind Chimeric's Connections screen.
  for(const inherited of ['AWS','Google Cloud','Microsoft Azure','NVIDIA API','OpenAlex','Literature access (journals, etc.)','API keys and tokens for services Claude uses on your behalf']){
   expect(component).not.toContain(inherited);
  }
  const expected=[
   ['LocalAnthropicCredentials','AnthropicCredentials','/api/local/providers/component.js'],
   ['LocalChatGPTCredentials','ChatGPTCredentials','/api/local/chatgpt/component.js'],
   ['LocalAntigravityConnection','AntigravityConnection','/api/local/antigravity/component.js'],
   ['LocalModelConnections','ModelConnections','/api/local/providers/component.js'],
   ['LocalImageGenerationSettings','ImageGenerationSettings','/api/local/image-generation/component.js'],
   ['LocalVoiceSettings','VoiceSettings','/api/local/speech/component.js'],
   ['LocalDecisionSettings','DecisionSettings','/api/local/classifiers/component.js'],
  ];
  const mounts=new Map<string,number>();
  function walk(node:any){
   if(!node||typeof node!=='object')return;
   if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&node.callee.property?.name==='jsx'&&node.arguments[0]?.type==='Identifier'){
    const name=node.arguments[0].name;mounts.set(name,(mounts.get(name)??0)+1);
   }
   for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
  }
  walk(program);
  for(const [local,imported,path] of expected){
   const imports=program.body.filter((node:any)=>node.type==='ImportDeclaration'&&node.source.value===path) as any[];
   expect(imports).toHaveLength(1);expect(imports[0].specifiers.map((value:any)=>[value.local.name,value.imported.name])).toContainEqual([local,imported]);expect(mounts.get(local)).toBe(1);
  }
  const sequence=expected.map(([name])=>component.indexOf('.jsx('+name+','));
  expect(sequence.every((value,i)=>value>=0&&(i===0||value>sequence[i-1]))).toBe(true);
  expect(component).not.toContain('/api/local/antigravity/workbench');expect(component).not.toContain('antigravity-client');
  const capabilities=readFileSync(join(manifest.root,'web-dist/assets/CapabilitiesPage-D3j7I2By.js'),'utf8');
  expect(capabilities).toContain('S as LocalChimericConnections');
  expect(capabilities.match(/e\.jsx\(LocalChimericConnections\.ConnectionsContent,\{\}\)/g)).toHaveLength(2);
  expect(capabilities).not.toContain('e.jsx(da,{})');
  const main=readFileSync(join(manifest.root,'web-dist/assets/index-BgpYmw3d.js'),'utf8');
  expect(main).toContain('ImageGenerationChoice as LocalChimericImageGenerationChoice');
  expect(main.match(/a\.jsx\(LocalChimericImageGenerationChoice,\{compact:!0\}\)/g)).toHaveLength(1);
  expect(main.match(/a\.jsx\(LocalChimericUsageIndicator,\{modelId:we,frameId:b\}\)/g)).toHaveLength(1);
  expect(main).toContain('UsageIndicator as LocalChimericUsageIndicator');
  const mounted=parse(main,{sourceType:'module'}).program;
  const imports=mounted.body.filter((node:any)=>node.type==='ImportDeclaration'&&node.source.value==='/api/local/confidentiality/component.js') as any[];
  expect(imports).toHaveLength(1);expect(imports[0].specifiers.map((node:any)=>[node.local.name,node.imported.name])).toEqual([['LocalChimericConfidentialityControl','ConfidentialityControl'],['LocalChimericOutboundReviews','OutboundReviews'],['LocalChimericPolicyModelPicker','PolicyModelPicker']]);
  const nodes:any[]=[];function collect(node:any){if(!node||typeof node!=='object')return;nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')collect(value)}collect(mounted);
  const options=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id?.name==='VVt'),composer=nodes.find(node=>node.type==='VariableDeclarator'&&node.id?.name==='Y9'&&node.init?.arguments?.[0]?.type==='FunctionExpression')?.init.arguments[0];
  expect(options.params[0].properties.some((node:any)=>node.key?.name==='chimericRootFrameId'&&node.value?.name==='chimericRootFrameId')).toBe(true);
  expect(composer.params[0].properties.find((node:any)=>node.key?.name==='currentRootFrameId')?.value.name).toBe('b');
  const calls=nodes.filter(node=>node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&['jsx','jsxs'].includes(node.callee.property?.name));
  const policy=calls.filter(node=>node.arguments[0]?.name==='LocalChimericConfidentialityControl');expect(policy).toHaveLength(1);
  expect(policy[0].start).toBeGreaterThan(options.start);expect(policy[0].end).toBeLessThan(options.end);
  expect(policy[0].arguments[1].properties.find((node:any)=>node.key?.name==='frameId')?.value.name).toBe('chimericRootFrameId');
  const menu=calls.filter(node=>node.arguments[0]?.name==='VVt');expect(menu).toHaveLength(1);expect(menu[0].arguments[1].properties.find((node:any)=>node.key?.name==='chimericRootFrameId')?.value.name).toBe('b');
  const rootChildren=composer.body.body.at(-1).argument.arguments[1].properties.find((node:any)=>node.key?.name==='children').value.elements;
  const reviews=rootChildren[1];expect(reviews.type).toBe('LogicalExpression');expect(main.slice(reviews.left.start,reviews.left.end)).toBe('b!=null');expect(reviews.right.arguments[0].name).toBe('LocalChimericOutboundReviews');expect(reviews.right.arguments[1].properties[0].value.name).toBe('b');
  expect(rootChildren[2].arguments[1].properties.some((node:any)=>node.key?.value==='data-testid'&&node.value?.value==='composer')).toBe(true);
  expect(calls.filter(node=>node.arguments[0]?.name==='LocalChimericOutboundReviews')).toHaveLength(1);
  expect(main).not.toContain('https://claude.ai/admin-settings/');expect(main).not.toContain('https://claude.com/upgrade?');
  expect(main).toContain('/api/local/help#connections');
  expect(main).not.toContain('https://status.claude.com');
  expect(manifest.moduleVersion).toMatch(/^\?chimeric=[a-f0-9]{16}$/);
  for(const name of ['scientific-writing','scientific-data-visualization','scientific-illustration','scientific-documents']){
   const entry=readFileSync(join(manifest.root,'skills',name,'SKILL.md'),'utf8');
   expect(entry).toContain('name: '+name);
   expect(entry).not.toContain('/Users/');
  }
 }finally{rmSync(directory,{recursive:true,force:true})}
},60000);

test('frontend link repair preserves explicit provider links while updating retired app documentation',()=>{
 const source='export const links={providerDocs:"https://docs.anthropic.com/en/docs/claude-code",providerUsage:"https://claude.ai/settings/usage",providerStatus:"https://status.claude.com",appDocs:"https://claude.com/docs/claude-science"};';
 const result=Bun.spawnSync([process.execPath,join(root,'tools/brand-frontend.mjs')],{cwd:root,env:{...process.env,BUN_BE_BUN:'1'},stdin:Buffer.from(JSON.stringify([{name:'./web-dist/assets/provider-links-fixture.js',text:source}])),stdout:'pipe',stderr:'pipe'});
 expect(result.exitCode,result.stderr.toString()).toBe(0);const changed=JSON.parse(result.stdout.toString()).files[0].text;
 expect(changed).toContain('https://docs.anthropic.com/en/docs/claude-code');expect(changed).toContain('https://claude.ai/settings/usage');expect(changed).toContain('/api/local/help#connections');expect(changed).toContain('/api/local/help');expect(changed).not.toContain('https://status.claude.com');expect(changed).not.toContain('https://claude.com/docs/claude-science');
});

test('first-run copy does not force an autonomous mode or retain the old Connections label',()=>{
 const source='export const copy={notice:"Auto mode is now on by default",detail:"Claude runs on its own and pauses to ask if anything looks unsafe.",title:"Credentials"};';
 const result=Bun.spawnSync([process.execPath,join(root,'tools/brand-frontend.mjs')],{cwd:root,env:{...process.env,BUN_BE_BUN:'1'},stdin:Buffer.from(JSON.stringify([{name:'./web-dist/assets/onboarding-copy-fixture.js',text:source}])),stdout:'pipe',stderr:'pipe'});
 expect(result.exitCode,result.stderr.toString()).toBe(0);const changed=JSON.parse(result.stdout.toString()).files[0].text;
 expect(changed).toContain('Chimeric is ready.');
 expect(changed).toContain('Chimeric works within the permissions you choose for each session.');
 expect(changed).toContain('Connections');
 expect(changed).not.toContain('Auto mode is now on by default');
 expect(changed).not.toContain('Claude runs on its own');
});
