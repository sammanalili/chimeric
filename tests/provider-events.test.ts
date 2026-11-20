import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {providerEventsPrelude} from './provider-events-fixture';

function fixture(failOnce=false){
 const sources:any[]=[];
 class Source{
  onmessage:((event:any)=>void)|null=null;closed=false;closes=0;
  constructor(readonly url:string){if(failOnce){failOnce=false;throw Error('Synthetic constructor rejection')}sources.push(this)}
  close(){this.closed=true;this.closes++}
 }
 const subscribe=runInNewContext(providerEventsPrelude+';subscribeProviderEvents',{EventSource:Source});
 return {sources,subscribe};
}

test('composer and settings listeners share one lazy same-origin event stream until the final unsubscribe',()=>{
 const f=fixture(),received:any[]=[];expect(f.sources).toHaveLength(0);
 const names=['native queries','model connections','usage chip','image settings','image composer','classifier settings','speech settings','confidentiality control','outgoing reviews','API permission one','API permission two'];
 const unsubs=names.map(name=>f.subscribe((event:any)=>received.push({name,data:event.data})));
 expect(f.sources).toHaveLength(1);expect(f.sources[0].url).toBe('/api/local/connections/events');
 f.sources[0].onmessage({data:'{"revision":2}'});expect(received).toEqual(names.map(name=>({name,data:'{"revision":2}'})));
 unsubs[0]();unsubs[0]();expect(f.sources[0].closed).toBe(false);
 for(const unsubscribe of unsubs.slice(1,-1))unsubscribe();expect(f.sources[0].closed).toBe(false);
 unsubs.at(-1)!();expect(f.sources[0].closed).toBe(true);expect(f.sources[0].closes).toBe(1);expect(f.sources[0].onmessage).toBe(null);
});

test('duplicate callbacks have independent subscriptions and one component cannot close another component feed',()=>{
 const f=fixture(),received:string[]=[];const callback=(event:any)=>received.push(event.data);
 const a=f.subscribe(callback),b=f.subscribe(callback);a();f.sources[0].onmessage({data:'remaining view'});expect(received).toEqual(['remaining view']);expect(f.sources[0].closed).toBe(false);b();expect(f.sources[0].closed).toBe(true);
});

test('closing then reopening the tab feed ignores queued events from the previous EventSource',()=>{
 const f=fixture(),received:string[]=[];const old=f.subscribe(()=>received.push('old')),queued=f.sources[0].onmessage;old();
 const current=f.subscribe(()=>received.push('current'));expect(f.sources).toHaveLength(2);queued({data:'late'});expect(received).toHaveLength(0);
 f.sources[1].onmessage({data:'fresh'});expect(received).toEqual(['current']);current();expect(f.sources.every(source=>source.closed)).toBe(true);
});

test('a listener failure or unsubscribe during notification does not interrupt the other mounted views',()=>{
 const f=fixture(),received:string[]=[];let stopSecond=()=>{};
 const first=f.subscribe(()=>{received.push('first');stopSecond();throw Error('Synthetic stale consumer')});
 stopSecond=f.subscribe(()=>received.push('second'));const third=f.subscribe(()=>received.push('third'));
 f.sources[0].onmessage({data:'revision'});expect(received).toEqual(['first','third']);expect(f.sources).toHaveLength(1);first();third();
});

test('a constructor failure leaves no stranded subscriber and a later mount can establish one feed',()=>{
 const f=fixture(true);expect(()=>f.subscribe(()=>{})).toThrow('Synthetic constructor rejection');
 const unsubscribe=f.subscribe(()=>{});expect(f.sources).toHaveLength(1);unsubscribe();expect(f.sources[0].closed).toBe(true);
});

test('an environment without EventSource does not create another transport or provider polling',()=>{
 const subscribe=runInNewContext(providerEventsPrelude+';subscribeProviderEvents',{});const unsubscribe=subscribe(()=>{throw Error('No event was sent')});expect(typeof unsubscribe).toBe('function');unsubscribe();unsubscribe();
});

test('all active browser consumers import the same feed module and create no private EventSource',()=>{
 for(const name of ['provider-settings','image-generation-settings','usage-indicator','class2-settings','decision-settings','voice-settings']){
  const source=readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8'),ast=parse(source,{sourceType:'module'});
  const imports=ast.program.body.filter(node=>t.isImportDeclaration(node)&&node.source.value==='/api/local/connections/events.js') as t.ImportDeclaration[];
  expect(imports,name).toHaveLength(1);expect(imports[0].specifiers.some(node=>t.isImportSpecifier(node)&&t.isIdentifier(node.imported,{name:'subscribeProviderEvents'}))).toBe(true);
  let constructors=0,subscribers=0;t.traverseFast(ast,node=>{if(t.isNewExpression(node)&&t.isIdentifier(node.callee,{name:'EventSource'}))constructors++;if(t.isCallExpression(node)&&t.isIdentifier(node.callee,{name:'subscribeProviderEvents'}))subscribers++});
  expect(constructors,name).toBe(0);expect(subscribers,name).toBeGreaterThan(0);
 }
});
