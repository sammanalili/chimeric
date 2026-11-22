const artifact=/!\[([^\]\n]{0,512})\]\(\{\{artifact:([A-Za-z0-9][A-Za-z0-9._:-]{0,254})\}\}\)/g;
const ignored=new Set(['SCRIPT','STYLE','TEXTAREA','OPTION']);
// Code samples, protected inert views and editors must remain literal text.
// Use ancestors as syntax highlighting and rich-text editors nest spans.
const literalContext='pre,code,[data-chimeric-resource],[data-chimeric-artifact-markdown],[contenteditable]:not([contenteditable="false" i]),[role="textbox" i]';

export function artifactImageParts(value){
 if(typeof value!=='string')return [];
 const parts=[];let cursor=0;artifact.lastIndex=0;
 for(let match;(match=artifact.exec(value));){
  if(match.index>cursor)parts.push({kind:'text',value:value.slice(cursor,match.index)});
  parts.push({kind:'image',alt:match[1],versionId:match[2]});cursor=artifact.lastIndex;
 }
 if(cursor<value.length)parts.push({kind:'text',value:value.slice(cursor)});
 return parts;
}

export function artifactImageUrl(versionId){return '/api/local/resources/image?versionId='+encodeURIComponent(versionId)}

function replaceTextNode(node,document){
 const parent=node.parentElement;if(!parent||ignored.has(parent.tagName)||parent.closest(literalContext))return;
 const parts=artifactImageParts(node.nodeValue);if(!parts.some(part=>part.kind==='image'))return;
 const fragment=document.createDocumentFragment();
 for(const part of parts){
  if(part.kind==='text'){fragment.append(document.createTextNode(part.value));continue}
  const figure=document.createElement('figure'),image=document.createElement('img');
  figure.dataset.chimericArtifactMarkdown='true';figure.style.margin='0.75rem 0';
  image.src=artifactImageUrl(part.versionId);image.alt=part.alt||'Generated image';image.loading='lazy';image.referrerPolicy='no-referrer';image.style.cssText='display:block;max-width:100%;max-height:70vh;object-fit:contain;border-radius:0.5rem';
  figure.append(image);fragment.append(figure);
 }
 parent.replaceChild(fragment,node);
}

export function installArtifactMarkdownResolver(document=globalThis.document){
 if(!document?.body||document.documentElement?.dataset?.chimericArtifactResolver==='true')return;
 document.documentElement.dataset.chimericArtifactResolver='true';let queued=false;
 const scan=()=>{
  queued=false;const walker=document.createTreeWalker(document.body,globalThis.NodeFilter?.SHOW_TEXT??4);const nodes=[];
  for(let node=walker.nextNode();node;node=walker.nextNode())if(node.nodeValue?.includes('{{artifact:'))nodes.push(node);
  for(const node of nodes)replaceTextNode(node,document);
 };
 const schedule=()=>{if(queued)return;queued=true;queueMicrotask(scan)};
 new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,characterData:true});schedule();
}

if(typeof document!=='undefined')installArtifactMarkdownResolver(document);
