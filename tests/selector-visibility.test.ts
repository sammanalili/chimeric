import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../src/registry';
import {makeCatalog} from '../src/catalog';
import {ProviderManager} from '../src/provider-manager';
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})});
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'chimeric-selector-visibility-'));directories.push(directory);
 const registry=new Registry({envFile:'/missing',credentialRefsFile:'/missing',modelMetadataFile:'/missing',providers:{mock:{name:'Synthetic provider',baseUrl:'https://models.example.invalid/v1',models:[{id:'current',name:'Current chat'},{id:'other',name:'Other chat'},{id:'image',mode:'image_generation'},{id:'speech',mode:'speech'},{id:'embedding',mode:'embedding'}],modelOverrides:{current:{reasoning:true,reasoningEfforts:{high:'high'}}}}},defaultModel:'mock::current',headlineModels:['mock::current']},directory,new Map([['mock','SYNTHETIC_KEY']]));
 await registry.refresh(false);registry.select('mock::current','high');return {directory,registry,manager:new ProviderManager(registry)};
}
const selectable=(r:Registry)=>makeCatalog(r).model_selector.catalog.models.filter(m=>!m.disabled).map(m=>m.id);
const settings=(f:Awaited<ReturnType<typeof fixture>>,patch:any={})=>({expectedRevision:f.registry.revision,roles:{...f.registry.config.roles},headlineModels:[...f.registry.config.headlineModels],...patch});

test('menus exclude incompatible endpoints and unavailable models but retain the exact current reference',async()=>{
 const f=await fixture();f.registry.models.get('mock::other')!.available=false;
 expect(selectable(f.registry)).toEqual(['mock::current']);
 expect(makeCatalog(f.registry).model_selector.catalog.models.find(m=>m.id==='mock::other')).toMatchObject({section:'deprecated',disabled:true});
 for(const id of ['image','speech','embedding'])expect(makeCatalog(f.registry).model_selector.catalog.models.some(m=>m.id==='mock::'+id)).toBe(false);
 for(const id of ['image','speech','embedding'])expect(f.registry.models.has('mock::'+id)).toBe(true);
 f.registry.models.get('mock::current')!.available=false;f.registry.models.get('mock::other')!.available=true;f.registry.models.get('mock::other')!.input=['image'];
 const catalog=makeCatalog(f.registry);expect(catalog.model_selector.catalog.models.every(m=>m.section==='deprecated'&&m.disabled)).toBe(true);expect(catalog.model_selector.catalog.models[0]).toMatchObject({id:'mock::current',name:'Current chat',section:'deprecated',disabled:true});expect(selectable(f.registry)).toEqual([]);
});

test('hiding the current model preserves its label, effort, credentials and dedicated output entries',async()=>{
 const f=await fixture(),current=f.registry.resolve('mock::current'),controller=new AbortController(),before=await f.registry.requestAuth(current,controller.signal),image=f.registry.models.get('mock::image'),speech=f.registry.models.get('mock::speech'),connection=f.registry.config.providers.mock.revision;
 const snapshot=await f.manager.settings(settings(f,{hiddenModels:['mock::current']}));
 expect(snapshot.hiddenModels).toEqual(['mock::current']);expect(snapshot.headlineModels).toEqual([]);expect(f.registry.currentSelection()).toEqual({model:'mock::current',effort:'high'});
 const catalog=makeCatalog(f.registry);expect(catalog.model_selector.catalog.models.find(m=>m.id==='mock::current')).toMatchObject({name:'Current chat',section:'deprecated',disabled:true});expect(catalog.model_selector.state.thinking).toEqual({type:'effort',effort:'high'});
 expect(selectable(f.registry)).toEqual(['mock::other']);expect(controller.signal.aborted).toBe(false);expect((await f.registry.requestAuth(current,controller.signal)).apiKey).toBe(before.apiKey);
 expect(f.registry.config.providers.mock.revision).toBe(connection);expect(f.registry.models.get('mock::image')).toEqual(image);expect(f.registry.models.get('mock::speech')).toEqual(speech);
});

test('qualified visibility persists and pinning or hiding updates both preferences coherently',async()=>{
 const f=await fixture();await f.manager.settings(settings(f,{hiddenModels:['other']}));
 const stored=JSON.parse(readFileSync(join(f.directory,'provider-config.json'),'utf8'));expect(stored.configuration.hiddenModels).toEqual(['mock::other']);
 const restored=new Registry(stored.configuration,f.directory);await restored.refresh(false);expect(selectable(restored)).toEqual(['mock::current']);
 let snapshot=await f.manager.settings(settings(f,{headlineModels:['mock::other']}));expect(snapshot.hiddenModels).toEqual([]);expect(snapshot.headlineModels).toEqual(['mock::other']);expect(selectable(f.registry)).toContain('mock::other');
 snapshot=await f.manager.settings(settings(f,{hiddenModels:['mock::other']}));expect(snapshot.headlineModels).toEqual([]);expect(snapshot.hiddenModels).toEqual(['mock::other']);expect(selectable(f.registry)).not.toContain('mock::other');
});

test('unrelated preferences preserve stale references while validating newly added references',async()=>{
 const f=await fixture();f.registry.config.roles={small:'missing::background'};f.registry.config.headlineModels=['missing::pinned'];f.registry.config.hiddenModels=['missing::hidden'];
 const snapshot=await f.manager.settings(settings(f,{headlineModels:['missing::pinned','mock::other'],hiddenModels:['missing::hidden','mock::current']}));expect(snapshot.roles).toEqual({small:'missing::background'});expect(snapshot.headlineModels).toEqual(['missing::pinned','mock::other']);expect(snapshot.hiddenModels).toEqual(['missing::hidden','mock::current']);
 await expect(f.manager.settings(settings(f,{roles:{small:'missing::new-background'}}))).rejects.toThrow('unknown or unavailable model');await expect(f.manager.settings(settings(f,{headlineModels:['missing::new-pin']}))).rejects.toThrow('unknown or unavailable model');
 await expect(f.manager.settings(settings(f,{headlineModels:['mock::image']}))).rejects.toThrow('cannot drive the analysis agent');f.registry.models.get('mock::other')!.available=false;
 await expect(f.manager.settings(settings(f,{headlineModels:['mock::other']}))).resolves.toMatchObject({headlineModels:['mock::other']});
 await f.manager.settings(settings(f,{headlineModels:[]}));await expect(f.manager.settings(settings(f,{headlineModels:['mock::other']}))).rejects.toThrow('available chat models');
 await expect(f.manager.settings(settings(f,{expectedRevision:0}))).rejects.toThrow('another window');
});

test('new conflicting pin and hide preferences fail without changing the configuration',async()=>{
 const f=await fixture();await expect(f.manager.settings(settings(f,{headlineModels:['mock::other'],hiddenModels:['mock::other']}))).rejects.toThrow('either pinning or hiding');expect(f.registry.revision).toBe(0);expect(f.registry.config.hiddenModels).toEqual([]);
});

test('pinning unhides a stored alias even when an older client omits the visibility field',async()=>{
 const f=await fixture();f.registry.config.hiddenModels=['other'];
 const snapshot=await f.manager.settings(settings(f,{headlineModels:['mock::other']}));expect(snapshot.hiddenModels).toEqual([]);expect(selectable(f.registry)).toContain('mock::other');
});

test('a hidden per-session selection retains its label and efforts when the global model is different',async()=>{
 const f=await fixture(),other=f.registry.models.get('mock::other')!;other.reasoning=true;other.efforts=['low','high'];
 await f.manager.settings(settings(f,{hiddenModels:['mock::other']}));
 const catalog=makeCatalog(f.registry),reference=catalog.model_selector.catalog.models.find(m=>m.id==='mock::other')!;
 expect(catalog.default_model_id).toBe('mock::current');expect(reference).toMatchObject({name:'Other chat',section:'deprecated',disabled:true});expect(reference.thinking?.effort_options.map(option=>option.id)).toContain('high');expect(selectable(f.registry)).not.toContain('mock::other');
});
