import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import packageInfo from '../package.json';
import {chimericVersion,installVersionHttp} from '../src/version-http';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true})});
function fixture(metadata?:unknown){
 const root=mkdtempSync(join(tmpdir(),'chimeric-version-'));temporary.push(root);mkdirSync(join(root,'runtime'));
 if(metadata!==undefined)writeFileSync(join(root,'chimeric-version.json'),JSON.stringify(metadata));
 return {root,moduleUrl:pathToFileURL(join(root,'runtime/local-runtime.js')).href};
}
function http(moduleUrl:string){
 const routes=new Map<string,Function>();
 installVersionHttp({get:(path:string,handler:Function)=>routes.set(path,handler),getUser:(request:any)=>request.user},'?chimeric=synthetic-version',{moduleUrl});
 return async(path:string,user:any)=>{
  const response:any={status:200,headers:{},body:undefined,header(name:string,value:string){this.headers[name]=value;return this},code(value:number){this.status=value;return this},type(value:string){this.headers['content-type']=value;return this},send(value:any){this.body=value;return this}};
  await routes.get(path)!({user},response);return response;
 };
}

test('source version uses the canonical package version without exposing package fields',()=>{
 expect(chimericVersion()).toEqual({product:'Chimeric',version:packageInfo.version});
 const f=fixture();expect(chimericVersion(f.moduleUrl)).toEqual({product:'Chimeric',version:packageInfo.version});
});

test('packaged app metadata supplies only its validated version',()=>{
 const f=fixture({version:'1.2.3-rc.4',privatePath:'/synthetic/private',apiKey:'SYNTHETIC_SECRET',account:{email:'unused@example.invalid'}});
 const snapshot=chimericVersion(f.moduleUrl);
 expect(snapshot).toEqual({product:'Chimeric',version:'1.2.3-rc.4'});expect(Object.isFrozen(snapshot)).toBe(true);
});

test('missing, malformed, oversized or symlinked app metadata falls back to the bundled version',()=>{
 for(const metadata of [{version:'<invalid>'},{version:123},['1.2.3'],{version:'1.2.3',padding:'x'.repeat(65536)}]){
  const f=fixture(metadata);expect(chimericVersion(f.moduleUrl).version).toBe(packageInfo.version);
 }
 const invalid=fixture();writeFileSync(join(invalid.root,'chimeric-version.json'),'{');expect(chimericVersion(invalid.moduleUrl).version).toBe(packageInfo.version);
 const linked=fixture();writeFileSync(join(linked.root,'other.json'),'{"version":"9.9.9"}');symlinkSync('other.json',join(linked.root,'chimeric-version.json'));
 expect(chimericVersion(linked.moduleUrl).version).toBe(packageInfo.version);
});

test('version routes require a native owner session, are not cached and freeze the startup identity',async()=>{
 const f=fixture({version:'1.2.3',apiKey:'SYNTHETIC_SECRET'}),request=http(f.moduleUrl);
 for(const path of ['/api/local/version','/api/local/version/component.js']){
  for(const user of [undefined,{user_id:'different-user'}]){
   const result=await request(path,user);expect(result.status).toBe(401);expect(result.headers['cache-control']).toBe('no-store');expect(result.body).toEqual({detail:'Open your local workspace again to continue.'});
  }
 }
 writeFileSync(join(f.root,'chimeric-version.json'),'{"version":"9.9.9"}');
 const result=await request('/api/local/version',{user_id:'local-dev'});
 expect(result.status).toBe(200);expect(result.headers['cache-control']).toBe('no-store');expect(result.body).toEqual({product:'Chimeric',version:'1.2.3'});
 const component=await request('/api/local/version/component.js',{user_id:'local-dev'});
 expect(component.status).toBe(200);expect(component.headers['content-type']).toBe('text/javascript; charset=utf-8');expect(component.body).toContain('/assets/vendor-CED4rDjN.js?chimeric=synthetic-version');expect(component.body).not.toContain('?science_local=chatgpt-v1');
});

test('General component displays the authenticated runtime version with same-origin credentials',async()=>{
 const source=readFileSync(new URL('../src/version-settings.js',import.meta.url),'utf8');
 const snapshot=chimericVersion(fixture().moduleUrl),calls:any[]=[];
 let state:any=null,mounted=false,cleanup:(()=>void)|undefined;
 const React={useState:()=>[state,(next:any)=>{state=next}],useEffect:(effect:()=>()=>void)=>{if(!mounted){mounted=true;cleanup=effect()}}};
 const jsx={jsx:(type:any,props:any)=>({type,props})};
 const fetch=async(...args:any[])=>{calls.push(args);return {ok:true,json:async()=>snapshot}};
 const factory=new Function('React','jsx','fetch',source.replace(/^import[^\n]+\n/,'').replaceAll('export function ','function ')+'\nreturn {VersionSettings,chimericVersionLabel};');
 const component=factory(React,jsx,fetch);
 expect(component.VersionSettings().props.children).toBe('Chimeric');await Bun.sleep(0);
 const output=component.VersionSettings();expect(output.props['data-testid']).toBe('chimeric-build-version');expect(output.props.children).toBe('Chimeric '+packageInfo.version);
 expect(calls).toHaveLength(1);expect(calls[0][0]).toBe('/api/local/version');expect(calls[0][1]).toMatchObject({credentials:'same-origin',cache:'no-store'});
 expect(component.chimericVersionLabel({product:'Other',version:'1.2.3'})).toBe('Chimeric');expect(component.chimericVersionLabel({product:'Chimeric',version:'<invalid>'})).toBe('Chimeric');
 cleanup?.();expect(calls[0][1].signal.aborted).toBe(true);
});

test('the General build mounts one dynamic version readout before language settings',()=>{
 const root=resolve(import.meta.dir,'..');
 const source='export function rl(){const mn=e.jsxs("div",{children:[e.jsx("p",{children:"Native general settings"})]});return mn}';
 const result=Bun.spawnSync([process.execPath,join(root,'tools/brand-frontend.mjs')],{cwd:root,env:{...process.env,BUN_BE_BUN:'1',CHIMERIC_FRONTEND_COMPLETE:'0'},stdin:Buffer.from(JSON.stringify([{name:'./web-dist/assets/ControlPanelModal-OAuv-kWB.js',text:source}])),stdout:'pipe',stderr:'pipe'});
 expect(result.exitCode,result.stderr.toString()).toBe(0);
 const output=JSON.parse(result.stdout.toString()).files[0].text;
 expect(output).toContain('from"/api/local/version/component.js"');expect(output.match(/e\.jsx\(LocalChimericVersionSettings,\{\}\)/g)).toHaveLength(1);
 expect(output).toContain('e.jsx(LocalChimericVersionSettings,{}),e.jsx(LocalChimericLanguageSettings,{})');expect(output).not.toContain(packageInfo.version);
});
