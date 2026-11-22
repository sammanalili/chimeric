import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import traverse0 from '@babel/traverse';
import {nativeVoiceFrontendEdits} from './native-voice-context.ts';
import {nativeBrowserPolicyEdits} from './native-browser-policy.ts';
import {nativeUploadContextEdits} from './native-upload-context.ts';
import {brandFrontendUserText} from './product-branding.ts';
const traverse=traverse0.default??traverse0;
const input=JSON.parse(readFileSync(0,'utf8'));
const atom=readFileSync(new URL('../src/atom-component.js.fragment',import.meta.url),'utf8').trim();
const dna=JSON.parse(readFileSync(new URL('../src/chimeric-dna.json',import.meta.url),'utf8'));
const japanese=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
// The native router can enter /login without an HTTP document request. Leave
// the research UI untouched and hand this one route to the local nonce gate.
// The marker bounds automatic navigation if an older backend is encountered.
const localLoginBody=`{const e=new URL(window.location.href),t=e.searchParams.has("_chimeric_local_entry"),label=globalThis.ChimericI18n?.t("Open local workspace")??"Open local workspace",open=()=>{const n=new URL("/login",window.location.origin);n.search=e.search;n.searchParams.delete("nonce");n.searchParams.set("_chimeric_local_entry",Date.now().toString(36));window.location.replace(n.href)};f.useEffect(()=>{if(!t)open()},[]);return a.jsx(jk,{children:a.jsxs("div",{className:"flex w-full flex-col gap-md",children:[a.jsx("p",{role:"status",children:t?(globalThis.ChimericI18n?.t("Open this workspace from the Chimeric app. No external account sign-in is required.")??"Open this workspace from the Chimeric app. No external account sign-in is required."):label}),t?a.jsx(_t,{variant:"primary",size:"lg",className:"w-full",onClick:open,children:label}):null]})})}`;
const copy=new Map([
  ['claude-science-default','chimeric-default'],['claude-science-…','chimeric-…'],
  ['Settings → Credentials','Settings → Connections'],
  ['Credentials','Connections'],
  ['Auto mode is now on by default','Chimeric is ready.'],
  ['Claude runs on its own and pauses to ask if anything looks unsafe.','Chimeric works within the permissions you choose for each session.'],
  ['Auto mode needs the sandbox. Turn the sandbox on to use it.','This mode needs the sandbox. Turn it on in Permissions if you want to use it.'],
  ['This includes existing chats that don\'t have their own setting. Turn it off for new chats in Settings → Permissions, or for one chat in its Session options.','Permissions are set per session and can be changed in Settings → Permissions.'],
  ['Share this ID with Anthropic support when reporting an issue.','Include this ID when reporting an issue.'],
  ['Research skills from Anthropic','Bundled research skills'],
  ['Research connectors from Anthropic','Bundled research connectors'],
  ['Research model skills from Anthropic','Bundled research model skills'],
  ["To prevent misuse, research outside your approved use cases may be flagged to Anthropic's safety team for review.",'Tool permissions and local safety checks apply to research requests.'],
  ["Feedback saved on this computer. Anthropic's feedback service didn't accept it.",'Report saved on this computer.'],
  ['Submitting this report will send the entire current conversation to Anthropic for future improvements to our safety systems.','Save this report’s session reference and selected reason on this computer.'],
  ['Offload heavy work to SSH hosts, your own cloud, or Anthropic-hosted compute. Not yet available in the standalone CLI.','Run heavy work on your SSH hosts or configured cloud compute.'],
  ['Anthropic-hosted','Managed compute'],['Hosted by Anthropic','Hosted service'],['Anthropic Internal','Bundled'],
  ['Publisher-supplied description — not reviewed by Anthropic','Publisher-supplied description'],['— not reviewed by Anthropic.',''],
  ['Anthropic Sans','Sans'],['Anthropic Serif','Serif'],
  ['Anthropic','Original bundle'],
  ['Default for new sessions — how long Claude thinks before responding. Higher effort is more thorough but slower and uses more of your limits. Change an individual session from its session options. Applies to models that support reasoning effort (Opus 4.5+ and Sonnet 4.6+).','Default reasoning effort for new sessions. Higher effort can take longer and use more tokens. Available levels depend on the selected model and endpoint. You can change the effort for each session.'],
]);
const copyProperties=new Set(['children','label','title','placeholder','aria-label','aria-description','alt','description','tooltip','sub','helpText','message','heading','body','serif','sans','author']);
function isCopy(path){
  let current=path.parentPath;
  for(let i=0;current&&i<5;i++,current=current.parentPath){
    if(current.node.type==='ObjectProperty')return copyProperties.has(current.node.key.name??current.node.key.value);
    if(!['ArrayExpression','ConditionalExpression','LogicalExpression','BinaryExpression'].includes(current.node.type))return false;
  }
  return false;
}
function helpURL(value,name=''){
  // This toast is shared by every model connection. Sending a RiVault or
  // OpenAI failure to a Claude status page is both misleading and leaks an
  // upstream product link into the standalone app.
  if(value==='https://status.claude.com')return '/api/local/help#connections';
  const appNavigation=/\/(?:index-BgpYmw3d|ControlPanelModal-OAuv-kWB)\.js$/.test(name);
  if(appNavigation){
    if(/^https:\/\/claude\.ai\/admin-settings\//.test(value))return '/api/local/help#permissions';
    if(/^https:\/\/claude\.ai\/settings(?:[/?#]|$)|^https:\/\/claude\.com\/upgrade(?:[/?#]|$)/.test(value))return '/api/local/help#models';
  }
  if(!appNavigation&&!value.includes('/claude-science'))return value;
  if(!/^https?:\/\/(?:www\.)?(?:claude\.com|support\.claude\.com|support\.anthropic\.com|docs\.anthropic\.com|anthropic\.com)\//.test(value))return value;
  if(!/docs|support|legal|privacy|claude-science|changelog|product/.test(value))return value;
  return '/api/local/help'+(/update|changelog/.test(value)?'#updates':/privacy|legal|your-data/.test(value)?'#privacy':/permission/.test(value)?'#permissions':/file|upload/.test(value)?'#files':'');
}
function importedPath(ast,matcher,imported,name){
  const matches=[];
  for(const declaration of ast.program.body){
    if(declaration.type!=='ImportDeclaration'||!matcher.test(declaration.source.value))continue;
    for(const specifier of declaration.specifiers){
      if(specifier.type==='ImportSpecifier'&&(specifier.imported.name??specifier.imported.value)===imported)matches.push(declaration.source.value);
    }
  }
  if(matches.length!==1)throw Error('Connections module import boundary changed for '+name);
  return matches[0];
}
function chimericConnectionsModule(ast){
  // Replace the inherited generic-secret directory rather than putting local
  // model cards above it. This ensures that AWS, cloud, and upstream
  // credential controls are neither rendered nor retained in this module.
  const vendor=importedPath(ast,/\/vendor-[^/]+\.js(?:\?|$)/,'j','jsx runtime');
  const shell=importedPath(ast,/\/index-BgpYmw3d\.js(?:\?|$)/,'L','settings modal');
  return `import{j as jsx}from${JSON.stringify(vendor)};import{L as Modal}from${JSON.stringify(shell)};import{AnthropicCredentials as LocalAnthropicCredentials,ModelConnections as LocalModelConnections}from"/api/local/providers/component.js";import{ChatGPTCredentials as LocalChatGPTCredentials}from"/api/local/chatgpt/component.js";import{AntigravityConnection as LocalAntigravityConnection}from"/api/local/antigravity/component.js";import{ImageGenerationSettings as LocalImageGenerationSettings}from"/api/local/image-generation/component.js";import{VoiceSettings as LocalVoiceSettings}from"/api/local/speech/component.js";import{DecisionSettings as LocalDecisionSettings}from"/api/local/classifiers/component.js";const tr=value=>globalThis.ChimericI18n?.t(value)??value;function ChimericConnectionsContent(){return jsx.jsx("div",{"data-testid":"chimeric-connections",className:"flex-1 overflow-y-auto px-4 py-3",children:jsx.jsxs("div",{children:[jsx.jsx("h2",{className:"sr-only",children:tr("Connections")}),jsx.jsx(LocalAnthropicCredentials,{}),jsx.jsx(LocalChatGPTCredentials,{}),jsx.jsx(LocalAntigravityConnection,{}),jsx.jsx(LocalModelConnections,{}),jsx.jsx(LocalImageGenerationSettings,{}),jsx.jsx(LocalVoiceSettings,{}),jsx.jsx(LocalDecisionSettings,{})]})})}function ChimericConnectionsModal({isOpen,onClose}){return jsx.jsx(Modal,{open:isOpen,onClose,size:"md",bodyClassName:"p-0",title:tr("Connections"),children:jsx.jsx(ChimericConnectionsContent,{})})}const connections=Object.freeze(Object.defineProperty({__proto__:null,ConnectionsContent:ChimericConnectionsContent,SecretsManagerContent:ChimericConnectionsContent,default:ChimericConnectionsModal},Symbol.toStringTag,{value:"Module"})),modal=Object.freeze(Object.defineProperty({__proto__:null,ConnectionsModal:ChimericConnectionsModal,SecretsManagerModal:ChimericConnectionsModal},Symbol.toStringTag,{value:"Module"}));export{connections as S,modal as i};`;
}
const connectionModules=input.filter(({text})=>text.includes('SecretsManagerContent')&&text.includes('SecretsManagerModal'));
const connectionModuleName=connectionModules.length===1?connectionModules[0].name.split('/').at(-1):null;
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function chimericCapabilitiesConnections(text){
  // The inherited Customize route has a second path to its fixed credential
  // catalogue. Keep the rest of that screen, but bind every credential route
  // to the same local Connections content as Settings.
  if(!connectionModuleName)throw Error('Could not identify the Chimeric Connections module');
  const modulePattern=new RegExp(`(["'])(\\./${escapeRegExp(connectionModuleName)}(?:\\?[^"']*)?)\\1`);
  const specifier=text.match(modulePattern)?.[2];
  if(!specifier)throw Error('Capabilities page no longer imports the Connections module');
  const inherited='e.jsx(da,{})';
  const occurrences=text.split(inherited).length-1;
  if(occurrences!==2)throw Error('Capabilities credential route boundary changed');
  const imported=`import{S as LocalChimericConnections}from${JSON.stringify(specifier)};`;
  if(text.includes(imported))throw Error('Capabilities Connections bridge was already added');
  const result=imported+text.replaceAll(inherited,'e.jsx(LocalChimericConnections.ConnectionsContent,{})');
  if(result.includes(inherited))throw Error('Inherited credential route was not fully replaced');
  return result;
}
const output=[];const inventory=[],browserPolicyFiles=new Set(),uploadContextFiles=new Set(),expectedBrowserPolicyFiles=new Set(['ArtifactTile-CFbnK3VR.js','RightPaneTabContent-CNO7IanA.js','HtmlPreview-CXBwtfOG.js','index-BgpYmw3d.js','HostMcpAppTile-DsGRshgh.js','McpAppTile-Bud9Ahpu.js']),expectedUploadContextFiles=new Set(['index-BgpYmw3d.js','useSessionActions-B0Qf6PUm.js']);let connectionsPanelRewrites=0;
let capabilitiesConnectionsRewrites=0;
for(const file of input){
  const {name,text:sourceText}=file,sourceAst=parse(sourceText,{sourceType:'unambiguous'}),browserEdits=nativeBrowserPolicyEdits(sourceAst,sourceText,name),uploadEdits=nativeUploadContextEdits(sourceAst,sourceText,name);
  if(browserEdits.length)browserPolicyFiles.add(name.split('/').at(-1));browserEdits.sort((a,b)=>b.start-a.start);for(let i=1;i<browserEdits.length;i++)if(browserEdits[i].end>browserEdits[i-1].start)throw Error('Overlapping native browser edits in '+name);
  if(uploadEdits.length)uploadContextFiles.add(name.split('/').at(-1));const nativeEdits=[...browserEdits,...uploadEdits].sort((a,b)=>b.start-a.start);for(let i=1;i<nativeEdits.length;i++)if(nativeEdits[i].end>nativeEdits[i-1].start)throw Error('Overlapping native policy edits in '+name);
  let text=sourceText;for(const edit of nativeEdits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  if(text.includes('case"credentials":return e.jsx(da,{})')&&text.includes('function ln({tab:t,route:s})')){
    text=chimericCapabilitiesConnections(text);capabilitiesConnectionsRewrites++;
  }
  const ast=parse(text,{sourceType:'unambiguous'}),edits=[],usageAnchors=new Set();
  if(name.endsWith('/index-DXq2yXE0.js')){
    const replacement=chimericConnectionsModule(ast);
    parse(replacement,{sourceType:'module'});
    output.push({name,text:replacement,edits:1});connectionsPanelRewrites++;continue;
  }
  let atoms=0,logos=0,events=0,staticAtoms=0,generalLanguage=0,localLogins=0,imageChoices=0,voiceFallbacks=0,voiceLabels=0,confidentialityParams=0,confidentialityBindings=0,outboundReviews=0;
  traverse(ast,{
    FunctionDeclaration(path){
      if(name.endsWith('/index-BgpYmw3d.js')&&path.node.id?.name==='VVt'){
        const props=path.node.params[0];
        if(path.node.params.length!==1||props?.type!=='ObjectPattern'||!props.properties.some(p=>p.key?.name==='computePickerRootFrameId'&&p.value?.name==='l')||!props.properties.some(p=>p.key?.name==='isDraft'&&p.value?.name==='o')||text.slice(path.node.start,path.node.end).includes('chimericRootFrameId'))throw Error('Native confidentiality options parameter boundary changed');
        edits.push({start:props.start+1,end:props.start+1,text:'chimericRootFrameId,'});confidentialityParams++;
      }
      if(name.endsWith('/index-BgpYmw3d.js')&&path.node.id?.name==='EFt'){
        // This signed native hook can silently choose browser-managed speech
        // recognition after a bridge error. Keep its existing failure reducer
        // and ownership release, but never select another audio destination.
        const n=path.node;
        if(createHash('sha256').update(text.slice(n.start,n.end)).digest('hex')!=='166f89046a5fdeed40aec1a88a87a3345637baf4a69a2bbacc9701cb2cf3657e')throw Error('Native dictation fallback boundary changed');
        const fallbacks=[],supports=[];
        path.traverse({VariableDeclarator(child){
          if(child.node.id.type==='Identifier'&&child.node.id.name==='L')fallbacks.push(child.node.init?.arguments?.[0]?.body);
          if(child.node.id.type==='ArrayPattern'&&child.node.id.elements[0]?.name==='c')supports.push(child.node.init?.arguments?.[0]);
        }});
        if(fallbacks.length!==1||supports.length!==1||fallbacks[0]?.type!=='BlockStatement'||supports[0]?.type!=='ArrowFunctionExpression')throw Error('Native dictation fallback controls changed');
        edits.push({start:fallbacks[0].start,end:fallbacks[0].end,text:'{E.current=!1,$(""),m({type:"fail",message:globalThis.ChimericI18n?.t("Voice transcription failed. Check the selected transcription connection and try again.")??"Voice transcription failed. Check the selected transcription connection and try again."}),qf(H.current)}'});
        // Server dictation does not depend on the browser WebSpeech API.
        edits.push({start:supports[0].start,end:supports[0].end,text:'()=>!0'});voiceFallbacks++;
      }
      if(!name.endsWith('/index-BgpYmw3d.js')||path.node.id?.name!=='Bsn')return;
      const n=path.node,original=text.slice(n.body.start,n.body.end);
      if(n.params.length!==0||!original.includes('/api/auth/login?provider=')||!original.includes('Paste code instead'))throw Error('Native login component boundary changed');
      edits.push({start:n.body.start,end:n.body.end,text:localLoginBody});localLogins++;path.skip();
    },
    CallExpression(path){
      const n=path.node;
      if(name.endsWith('/ControlPanelModal-OAuv-kWB.js')&&n.callee.type==='MemberExpression'&&['jsx','jsxs'].includes(n.callee.property.name)&&n.arguments[1]?.type==='ObjectExpression'){
        const props=n.arguments[1].properties;
        const test=props.find(p=>p.key?.value==='data-testid')?.value?.value;
        if(test==='settings-check-updates'){
          const handler=props.find(p=>p.key?.name==='onClick');
          if(!handler)throw Error('Missing native update control');
          edits.push({start:handler.value.start,end:handler.value.end,text:'()=>window.open("/api/local/help#updates","_blank","noopener,noreferrer")'});
        }
        if(test==='settings-view-changelog'){
          const href=props.find(p=>p.key?.name==='href');
          if(!href)throw Error('Missing native changelog link');
          edits.push({start:href.value.start,end:href.value.end,text:'"/api/local/help#updates"'});
        }
      }
      if(!name.endsWith('/index-BgpYmw3d.js'))return;
      if(n.callee.type==='MemberExpression'&&['jsx','jsxs'].includes(n.callee.property.name)&&n.arguments[0]?.name==='VVt'&&path.findParent(p=>p.isVariableDeclarator()&&p.node.id?.name==='Y9')){
        const props=n.arguments[1],draft=props?.properties?.find(p=>p.key?.name==='isDraft')?.value;
        if(props?.type!=='ObjectExpression'||draft?.type!=='BinaryExpression'||draft.operator!=='=='||draft.left?.name!=='b'||draft.right?.type!=='NullLiteral'||props.properties.some(p=>p.key?.name==='chimericRootFrameId'))throw Error('Native confidentiality composer scope boundary changed');
        edits.push({start:props.start+1,end:props.start+1,text:'chimericRootFrameId:b,'});confidentialityBindings++;
      }
      if(n.callee.type==='MemberExpression'&&['jsx','jsxs'].includes(n.callee.property.name)&&n.arguments[0]?.type==='MemberExpression'&&n.arguments[0].object.name==='ft'&&n.arguments[0].property.name==='Popup'&&path.findParent(p=>p.isFunctionDeclaration()&&p.node.id?.name==='VVt')){
        const props=n.arguments[1]?.properties;
        if(props?.some(p=>p.key?.name==='side'&&p.value?.value==='top')&&props.some(p=>p.key?.name==='align'&&p.value?.value==='start')){
          const children=props.find(p=>p.key?.name==='children')?.value;
          if(children?.type!=='ArrayExpression')throw Error('Native session options popup boundary changed');
          edits.push({start:children.start+1,end:children.start+1,text:'a.jsx(LocalChimericConfidentialityControl,{frameId:chimericRootFrameId,compact:!0}),a.jsx(ft.Separator,{}),a.jsx(LocalChimericImageGenerationChoice,{compact:!0}),a.jsx(ft.Separator,{}),'});imageChoices++;
        }
      }
      if(n.callee.type!=='MemberExpression'||!['jsx','jsxs'].includes(n.callee.property.name)||n.arguments[0]?.name!=='kLe'||n.arguments[1]?.type!=='ObjectExpression')return;
      const props=n.arguments[1].properties;
      if(!props.some(p=>p.key?.name==='client'&&p.value?.name==='won'))return;
      const child=props.find(p=>p.key?.name==='children')?.value;
      if(!child)throw Error('Missing native query provider child');
      edits.push({start:child.start,end:child.start,text:'a.jsxs(a.Fragment,{children:[a.jsx(LocalChimericProviderEvents,{}),'});
      edits.push({start:child.end,end:child.end,text:']})'});events++;
    },
    ConditionalExpression(path){
      if(!name.endsWith('/index-BgpYmw3d.js')||!path.findParent(p=>p.isFunctionDeclaration()&&p.node.id?.name==='Qj'))return;
      const n=path.node,test=n.test;
      if(test.type!=='BinaryExpression'||test.operator!=='==='||test.left.name!=='w'||test.right.value!=='server')return;
      const next=n.alternate;
      if(n.consequent.value!==' · transcribed by your Claude account'||next.type!=='ConditionalExpression'||next.test.type!=='BinaryExpression'||next.test.operator!=='==='||next.test.left.name!=='w'||next.test.right.value!=='webspeech'||next.consequent.value!==' · browser transcription (fallback — toggle to retry Claude voice)'||next.alternate.value!=='')throw Error('Native dictation destination label boundary changed');
      // The selected local or remote destination is supplied by voice preflight.
      edits.push({start:n.start,end:n.end,text:'""'});voiceLabels++;path.skip();
    },
    ObjectProperty(path){
      if(!name.endsWith('/index-BgpYmw3d.js')||(path.node.key.value??path.node.key.name)!=='data-testid'||path.node.value.value!=='model-selector'||!path.findParent(p=>p.isVariableDeclarator()&&p.node.id?.name==='Y9'))return;
      const array=path.findParent(p=>p.isArrayExpression()),item=array&&path.findParent(p=>p.parentPath===array);
      if(item?.node.type!=='LogicalExpression'||item.node.operator!=='&&'||item.node.left?.type!=='BinaryExpression'||item.node.left.left?.name!=='we')throw Error('Native composer model picker boundary changed');
      if(!usageAnchors.has(item.node.end)){usageAnchors.add(item.node.end);edits.push({start:item.node.end,end:item.node.end,text:',we!==void 0&&a.jsx(LocalChimericUsageIndicator,{modelId:we,frameId:b})'});edits.push({start:item.node.start,end:item.node.start,text:'a.jsx(LocalChimericPolicyModelPicker,{frameId:b,fallback:'});edits.push({start:item.node.end,end:item.node.end,text:'})'})}
    },
    VariableDeclarator(path){
      if(name.endsWith('/ControlPanelModal-OAuv-kWB.js')&&path.node.id?.name==='mn'&&path.findParent(p=>p.isFunction())?.node.id?.name==='rl'){
        const n=path.node.init;
        const children=n?.arguments?.[1]?.properties?.find(p=>p.key?.name==='children')?.value;
        if(n?.callee?.property?.name!=='jsxs'||n.arguments[0]?.value!=='div'||children?.type!=='ArrayExpression')throw Error('Native General settings container changed');
        edits.push({start:children.start+1,end:children.start+1,text:'e.jsx(LocalChimericLanguageSettings,{}),'});generalLanguage++;
      }
      if(!name.endsWith('/index-BgpYmw3d.js'))return;
      if(path.node.id?.name==='Y9'){
        const fn=path.node.init?.arguments?.[0],params=fn?.params?.[0],rootId=params?.properties?.find(p=>p.key?.name==='currentRootFrameId')?.value;
        const returned=fn?.body?.body?.at(-1)?.argument,children=returned?.arguments?.[1]?.properties?.find(p=>p.key?.name==='children')?.value,composer=children?.elements?.[1];
        const props=composer?.arguments?.[1]?.properties;
        if(fn?.type!=='FunctionExpression'||params?.type!=='ObjectPattern'||rootId?.name!=='b'||returned?.callee?.property?.name!=='jsxs'||returned.arguments[0]?.value!=='div'||children?.type!=='ArrayExpression'||!props?.some(p=>p.key?.value==='data-testid'&&p.value?.value==='composer'))throw Error('Native outgoing review composer boundary changed');
        edits.push({start:composer.start,end:composer.start,text:'b!=null&&a.jsx(LocalChimericOutboundReviews,{frameId:b}),'});outboundReviews++;
      }
      if(path.node.id?.name==='Uj'){
        if(!path.node.init)throw Error('Missing original working indicator');
        edits.push({start:path.node.init.start,end:path.node.init.end,text:atom});atoms++;
        path.skip();
      }
      if(path.node.id?.name==='bnt'){
        if(path.node.init?.type!=='ObjectExpression')throw Error('Missing original DNA illustration');
        edits.push({start:path.node.init.start,end:path.node.init.end,text:JSON.stringify(dna)});logos++;
        path.skip();
      }
      if(path.node.id?.name==='Cme'){
        edits.push({start:path.node.init.start,end:path.node.init.end,text:'({size:e=32,color:t=K8e,className:n})=>a.jsxs("svg",{"data-cds":"Atom",width:e,height:e,viewBox:"0 0 24 24",fill:"none",className:n,"aria-hidden":true,children:[...[0,60,120].map(r=>a.jsx("ellipse",{cx:12,cy:12,rx:9.6,ry:4.1,stroke:t,strokeWidth:0.9,transform:`rotate(${r} 12 12)`},r)),a.jsx("circle",{cx:12,cy:12,r:1.8,fill:t})]})'});staticAtoms++;path.skip();
      }
    },
    StringLiteral(path){
      const value=path.node.value;
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(path.parentPath.node.type)&&path.parentPath.node.source===path.node)return;
      const ui=isCopy(path)||(name.endsWith('/ControlPanelModal-OAuv-kWB.js')&&
        (['general','usage','network','system','light','dark'].includes(path.parentPath.node.key?.name)||
         path.node.value==='Not set'))||(['Today','Yesterday'].includes(path.node.value)&&path.parentPath.isReturnStatement());
      // Keep real model identities, imported formats, legal attribution and font names.
      const retained=(/Claude|Anthropic/.test(value)&&/Claude\s+(?:Opus|Sonnet|Haiku|Code)\b|Anthropic(?: Sans| Serif|Sans|Serif)|copyright|©|(?:MIT|Apache|BSD|Open Font) License/i.test(value)&&!(ui&&copy.has(value)))||value.length>16000;
      let next=retained?value:copy.get(value)??value.replace(/\bClaude(?: Science| Bioscience)?\b/g,'Chimeric').replaceAll('[claude-science]','[chimeric]');
      next=brandFrontendUserText(next,name);
      next=helpURL(next,name);
      if(next==='Credentials')next='Connections';
      if(ui&&next==='Commercial use (default)')next='Commercial use';
      if(ui&&next==='Non-commercial use')next='Non-commercial use (default)';
      if(name.endsWith('/ControlPanelModal-OAuv-kWB.js')&&ui&&next==='Check for updates')next='Update instructions';
      const translated=ui&&Object.hasOwn(japanese,next);
      if(/Claude|Anthropic/.test(value)||next!==value||translated)inventory.push({file:name,original:value,replacement:next,retained,translated});
      const replacement=translated?'(globalThis.ChimericI18n?.t('+JSON.stringify(next)+')??'+JSON.stringify(next)+')':JSON.stringify(next);
      if(next!==value||translated)edits.push({start:path.node.start,end:path.node.end,text:replacement});
    },
    TemplateLiteral(path){
      const value=path.node.quasis[0]?.value.raw??'',next=helpURL(value,name);
      if(next!==value){edits.push({start:path.node.start,end:path.node.end,text:JSON.stringify(next)});inventory.push({file:name,original:value,replacement:next,template:true});path.skip()}
    },
    TemplateElement(path){
      const value=path.node.value.raw;
      if(/Claude\s+(?:Opus|Sonnet|Haiku|Code)\b|copyright|©|Anthropic(?:Sans|Serif)/i.test(value))return;
      let next=copy.get(value)??value.replace(/\bClaude(?: Science| Bioscience)?\b/g,'Chimeric').replaceAll('[claude-science]','[chimeric]').replace(/Anthropic-hosted/g,'Managed').replace(/Anthropic(?:'s|’s)/g,'the original publisher’s').replace(/Anthropic support/g,'your administrator');
      next=brandFrontendUserText(next,name);
      if(next!==value){edits.push({start:path.node.start,end:path.node.end,text:next});inventory.push({file:name,original:value,replacement:next,template:true})}
    },
  });
  if(name.endsWith('/index-BgpYmw3d.js'))edits.push(...nativeVoiceFrontendEdits(ast,text));
  if(name.endsWith('/index-BgpYmw3d.js')&&(atoms!==1||logos!==1||events!==1||staticAtoms!==1||localLogins!==1||imageChoices!==1||usageAnchors.size!==1||voiceFallbacks!==1||voiceLabels!==1||confidentialityParams!==1||confidentialityBindings!==1||outboundReviews!==1))throw Error('Chimeric component boundaries changed: '+JSON.stringify({atoms,logos,events,staticAtoms,localLogins,imageChoices,usageAnchors:usageAnchors.size,voiceFallbacks,voiceLabels,confidentialityParams,confidentialityBindings,outboundReviews}));
  if(name.endsWith('/ControlPanelModal-OAuv-kWB.js')&&generalLanguage!==1)throw Error('Missing General language settings boundary');
  edits.sort((a,b)=>b.start-a.start);
  for(let i=1;i<edits.length;i++)if(edits[i].end>edits[i-1].start)throw Error('Overlapping frontend edits in '+name+': '+JSON.stringify([{start:edits[i-1].start,end:edits[i-1].end,label:edits[i-1].label,text:String(edits[i-1].text).slice(0,80)},{start:edits[i].start,end:edits[i].end,label:edits[i].label,text:String(edits[i].text).slice(0,80)}]));
  let result=text;
  for(const edit of edits)result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  if(name.endsWith('/index-BgpYmw3d.js'))result='import{ConfidentialityControl as LocalChimericConfidentialityControl,OutboundReviews as LocalChimericOutboundReviews,PolicyModelPicker as LocalChimericPolicyModelPicker}from"/api/local/confidentiality/component.js";import{UsageIndicator as LocalChimericUsageIndicator}from"/api/local/usage/component.js";import{ImageGenerationChoice as LocalChimericImageGenerationChoice}from"/api/local/image-generation/component.js";import{ProviderEvents as LocalChimericProviderEvents}from"/api/local/providers/component.js";'+result;
  if(name.endsWith('/ControlPanelModal-OAuv-kWB.js'))result='import{LanguageSettings as LocalChimericLanguageSettings}from"/api/local/providers/component.js";'+result;
  // Parse the final module as well; a successful string substitution is insufficient.
  if(edits.length)parse(result,{sourceType:'unambiguous'});
  output.push({name,text:result,edits:edits.length+nativeEdits.length});
}
if(process.env.CHIMERIC_FRONTEND_COMPLETE==='1'&&(browserPolicyFiles.size!==expectedBrowserPolicyFiles.size||[...expectedBrowserPolicyFiles].some(name=>!browserPolicyFiles.has(name))))throw Error('Missing native browser policy assets: '+JSON.stringify([...browserPolicyFiles]));
if(process.env.CHIMERIC_FRONTEND_COMPLETE==='1'&&(uploadContextFiles.size!==expectedUploadContextFiles.size||[...expectedUploadContextFiles].some(name=>!uploadContextFiles.has(name))))throw Error('Missing native upload context assets: '+JSON.stringify([...uploadContextFiles]));
if(process.env.CHIMERIC_FRONTEND_COMPLETE==='1'&&connectionsPanelRewrites!==1)throw Error('Missing Chimeric Connections panel rewrite');
if(process.env.CHIMERIC_FRONTEND_COMPLETE==='1'&&capabilitiesConnectionsRewrites!==1)throw Error('Missing inherited Capabilities Connections route rewrite');
process.stdout.write(JSON.stringify({files:output,inventory}));
