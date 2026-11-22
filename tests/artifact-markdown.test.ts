import {expect,test} from 'bun:test';
import {artifactImageParts,artifactImageUrl} from '../src/artifact-markdown.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const resolverSource=readFileSync(new URL('../src/artifact-markdown.js',import.meta.url),'utf8').replaceAll('export function ','function ');
const replaceTextNode=runInNewContext(resolverSource+';replaceTextNode',{});
// Small DOM spies exercise the actual resolver, including ancestor selection.
// The matcher implements only the tag/attribute/:not selectors used here.
function element(tag='div',attributes:Record<string,string>={},parentElement:any=null):any{
 const matches=(selector:string):boolean=>{
  const not=selector.indexOf(':not(');
  if(not>=0)return matches(selector.slice(0,not))&&!matches(selector.slice(not+5,-1));
  if(/^[a-z]+$/i.test(selector))return tag.toLowerCase()===selector.toLowerCase();
  const attr=selector.match(/^\[([\w-]+)(?:="([^"]*)"( i)?)?\]$/);
  if(!attr||!Object.hasOwn(attributes,attr[1]))return false;
  return attr[2]===undefined||!!attr[3]&&attributes[attr[1]].toLowerCase()===attr[2].toLowerCase()||attributes[attr[1]]===attr[2];
 };
 const node:any={tagName:tag.toUpperCase(),parentElement,dataset:{},style:{},children:[],replacements:[],matches,
  append(...values:any[]){node.children.push(...values)},
  closest(selector:string){for(let current:any=node;current;current=current.parentElement)if(selector.split(',').some(part=>current.matches(part.trim())))return current;return null},
  replaceChild(replacement:any,original:any){node.replacements.push({replacement,original})},
 };
 return node;
}
function resolveInside(ancestor:any,content='before ![Example]({{artifact:version-example}}) after'){
 const parent=element('span',{},ancestor),node={parentElement:parent,nodeValue:content};
 const document={createDocumentFragment:()=>element('fragment'),createTextNode:(text:string)=>({nodeType:3,textContent:text}),createElement:(tag:string)=>element(tag)};
 replaceTextNode(node,document);return parent.replacements;
}

test('artifact Markdown image references become exact local image URLs',()=>{
 const version='4463a7a9-f48e-4136-ab98-65a8710b97e3',parts=artifactImageParts('before ![Mouse image]({{artifact:'+version+'}}) after');
 expect(parts).toEqual([{kind:'text',value:'before '},{kind:'image',alt:'Mouse image',versionId:version},{kind:'text',value:' after'}]);
 expect(artifactImageUrl(version)).toBe('/api/local/resources/image?versionId='+version);
});

test('only exact inline image handles are transformed',()=>{
 for(const value of ['{{artifact:version}}','[file]({{artifact:version}})','![bad]({{artifact:../private}})','![too long]({{artifact:'+ 'a'.repeat(256)+'}})'])expect(artifactImageParts(value).some(part=>part.kind==='image')).toBe(false);
});

test('artifact image examples remain literal inside nested code and preformatted text',()=>{
 for(const tag of ['code','pre']){
  const ancestor=element(tag),nested=element('span',{},element('span',{},ancestor));
  expect(resolveInside(nested)).toHaveLength(0);
 }
 expect(resolveInside(element('code',{},element('pre')))).toHaveLength(0);
});

test('protected inert preview trees and already-resolved artifact figures are never activated',()=>{
 for(const decision of ['inert-markdown','inert-text','blocked']){
  const ancestor=element('div',{'data-chimeric-resource':decision});
  expect(resolveInside(element('span',{},ancestor))).toHaveLength(0);
 }
 expect(resolveInside(element('figure',{'data-chimeric-artifact-markdown':'true'}))).toHaveLength(0);
});

test('editable and textbox ancestors are never rewritten, including nested rich-text spans',()=>{
 for(const value of ['','true','TRUE','plaintext-only']){
  const editor=element('div',{contenteditable:value});
  expect(resolveInside(element('span',{},editor))).toHaveLength(0);
 }
 for(const role of ['textbox','TEXTBOX'])expect(resolveInside(element('div',{role}))).toHaveLength(0);
});

test('ordinary read-only message text still resolves to the exact checked local image URL',()=>{
 for(const ancestor of [element('div'),element('p'),element('div',{contenteditable:'false'}),element('div',{contenteditable:'FALSE'})]){
  const changed=resolveInside(ancestor);expect(changed).toHaveLength(1);
  const children=changed[0].replacement.children;expect(children[0].textContent).toBe('before ');expect(children[2].textContent).toBe(' after');
  const image=children[1].children[0];expect(image.tagName).toBe('IMG');expect(image.src).toBe('/api/local/resources/image?versionId=version-example');expect(image.referrerPolicy).toBe('no-referrer');
 }
});
