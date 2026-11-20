import MarkdownIt from 'markdown-it';
const base='/api/local/antigravity',t=value=>globalThis.ChimericI18n?.t(value)??value;
const md=new MarkdownIt({html:false,linkify:false,typographer:false});
md.renderer.rules.image=(tokens,index)=>'<span class="image-reference">'+md.utils.escapeHtml(tokens[index].content||t('Image reference'))+'</span>';
const originalLink=md.renderer.rules.link_open??((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
md.renderer.rules.link_open=(tokens,index,options,env,self)=>{const href=tokens[index].attrGet('href');if(href&&!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)&&env?.session)tokens[index].attrSet('href',base+'/sessions/'+env.session+'/file?path='+encodeURIComponent(href));tokens[index].attrSet('rel','noopener noreferrer');tokens[index].attrSet('target','_blank');return originalLink(tokens,index,options,env,self)};
const el=(tag,attrs={},children=[])=>{const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);else if(key==='text')node.textContent=value;else if(key==='class')node.className=value;else if(key==='disabled')node.disabled=!!value;else node.setAttribute(key,value)}for(const child of [children].flat())if(child!==null&&child!==false&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);return node};
const btn=(label,action,attrs={})=>el('button',{type:'button',text:t(label),onclick:action,...attrs});
const text=(tag,value,attrs={})=>el(tag,{text:t(value),...attrs});
const errorBox=el('div',{class:'error-banner',role:'alert',hidden:''});
function showError(error){errorBox.textContent=t(error.message??String(error));errorBox.hidden=false}
function clearError(){errorBox.hidden=true;errorBox.textContent=''}
async function api(path='',method='GET',body){
 if(method!=='GET'){const csrf=await fetch('/api/csrf',{credentials:'same-origin'});if(!csrf.ok)throw Error('Open your local workspace again to continue.')}
 const cookie=document.cookie.split('; ').find(s=>s.startsWith('operon_csrf='));
 const r=await fetch(base+path,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(cookie?{'x-operon-csrf':decodeURIComponent(cookie.slice(12))}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 let data;try{data=await r.json()}catch{throw Error('The server returned an unexpected response.')}
 if(!r.ok)throw Error(data.detail||'Antigravity could not complete the operation.');return data;
}
const workspaceLink=el('a',{href:'/',class:'brand',title:t('Return to workspace')},[el('img',{src:'/favicon.svg',alt:'',width:'30',height:'30'}),text('span','Chimeric')]);
const sessionList=el('nav',{'aria-label':t('Antigravity sessions'),class:'session-list'});
const newButton=btn('New session',()=>act(async()=>{await newSession()}),{class:'new-session'});
const sidebar=el('aside',{class:'sidebar'},[workspaceLink,text('p','Antigravity',{class:'sidebar-label'}),newButton,sessionList,el('a',{href:'/',class:'back-link',text:'← '+t('Return to workspace')})]);
const titleNode=text('h1','Antigravity'),statusNode=el('span',{class:'status-pill',role:'status'});
const modelControls=el('div',{class:'model-controls'});
const refreshButton=btn('Refresh models',()=>act(async()=>{if(selected){await api('/sessions/'+selected+'/refresh','POST',{});await update()}}));
const connectButton=btn('Connect',()=>act(async()=>{await api('/connect','POST',{});await update()}));
const disconnectButton=btn('Disconnect',()=>act(async()=>{await api('/disconnect','POST',{});await update()}));
const signIn=el('div',{class:'sign-in-actions'});
const header=el('header',{class:'workbench-header'},[el('div',{class:'heading'},[titleNode,statusNode]),el('div',{class:'header-actions'},[signIn,connectButton,disconnectButton])]);
const intro=el('section',{class:'welcome'},[el('img',{src:'/favicon.svg',alt:'',width:'64',height:'64'}),text('h2','A separate space for Antigravity'),text('p','The official agent runs this session. Chimeric brings its conversation, files and permission requests into one place.'),text('p','Choose Connect to use the official CLI. Your existing Chimeric research stays in its current workspace.',{class:'muted'})]);
const transcript=el('div',{class:'transcript',role:'log','aria-live':'off','aria-label':t('Conversation')});
const permissionArea=el('section',{class:'permission-area','aria-label':t('Permission requests')});
const fileList=el('div',{class:'file-list'}),filePanel=el('details',{class:'workspace-files'},[text('summary','Workspace files'),fileList]);
const filesButton=btn('Refresh files',()=>act(loadFiles));
fileList.append(filesButton);
const messages=el('div',{class:'messages'},[intro,transcript]);
const composerText=el('textarea',{'aria-label':t('Message Antigravity'),placeholder:t('Ask a research question…'),rows:'2',maxlength:'256000'});
const attachmentStrip=el('div',{class:'attachment-strip'});
const fileInput=el('input',{type:'file',multiple:'','aria-label':t('Attach files'),class:'file-input'});
const attachButton=btn('Attach files',()=>fileInput.click(),{class:'quiet'});
const sendButton=el('button',{type:'submit',class:'send-button',text:t('Send')});
const stopButton=btn('Stop',()=>act(async()=>{if(selected)await api('/sessions/'+selected+'/cancel','POST',{});await update()}),{class:'stop-button'});
const form=el('form',{class:'composer',onsubmit:e=>{e.preventDefault();void send()}},[attachmentStrip,composerText,el('div',{class:'composer-toolbar'},[attachButton,fileInput,text('span','Enter to send · Shift+Enter for a new line',{class:'composer-hint'}),stopButton,sendButton])]);
const settings=el('details',{class:'connection-settings'},[text('summary','CLI connection'),text('label','Official agy executable',{for:'agy-path'}),el('input',{id:'agy-path',type:'text',spellcheck:'false',autocomplete:'off',placeholder:'/absolute/path/to/agy'}),btn('Save CLI path',()=>act(async()=>{await api('','PUT',{executable:document.getElementById('agy-path').value});await update()})),text('p','The CLI keeps your Google credentials. Chimeric stores this mode’s history and files locally.',{class:'muted'}),el('a',{href:'https://antigravity.google/docs/getting-started',target:'_blank',rel:'noopener noreferrer',text:t('Official CLI setup guide')})]);
const root=document.getElementById('antigravity-root');root.append(sidebar,el('main',{class:'workbench'},[header,errorBox,el('div',{class:'session-toolbar'},[modelControls,refreshButton]),messages,permissionArea,filePanel,form,text('p','Antigravity’s terms and data policies apply to content shared in this mode.',{class:'privacy-note'}),settings]));
let state,selected=null,events=[],cursor=0,generation=0,busy=false,refreshing=false,again=false,lastRendered='',lastPermissions='',pendingIntent=null,attachments=[];
const drafts=new Map();
function remember(){if(selected)drafts.set(selected,{text:composerText.value,attachments,pendingIntent})}
function restoreDraft(){const draft=drafts.get(selected);composerText.value=draft?.text??'';attachments=draft?.attachments??[];pendingIntent=draft?.pendingIntent??null;renderAttachments()}
function isRunning(){return state?.activeSessionId===selected}
async function act(action){if(busy)return;busy=true;clearError();renderControls();try{await action()}catch(error){showError(error)}finally{busy=false;renderControls()}}
async function newSession(){
 const result=await api('/sessions','POST',{title:t('Antigravity research')});await select(result.session.id);await update();composerText.focus();return result.session.id;
}
async function select(id){
 remember();selected=id;generation++;cursor=0;events=[];lastRendered='';lastPermissions='';restoreDraft();
 const url=new URL(location.href);url.searchParams.set('session',id);history.replaceState(null,'',url);await update();
}
async function update(){
 if(refreshing){again=true;return}refreshing=true;
 try{
  do{
   again=false;state=await api();renderSidebar();renderControls();
   const id=selected,version=generation;
   if(id){let more;do{const result=await api('/sessions/'+id+'?after='+cursor);if(version!==generation)break;events.push(...result.events);cursor=result.nextCursor;more=result.hasMore;
     const current=state.sessions.find(s=>s.id===id);if(current)Object.assign(current,result.session);
     renderSession(result);
    }while(more&&version===generation)}
  }while(again);
 }catch(error){showError(error)}finally{refreshing=false}
}
function renderSidebar(){
 if(!state)return;
 sessionList.replaceChildren(...state.sessions.map(session=>btn(session.title,()=>void select(session.id),{class:'session-link'+(selected===session.id?' selected':''),'aria-current':selected===session.id?'page':'false',title:session.title})));
}
function renderControls(){
 const connected=state?.connected??false,session=state?.sessions.find(s=>s.id===selected),active=!!state?.activeSessionId,operation=busy||state?.operation||state?.authState==='waiting';
 titleNode.textContent=session?.title??t('Antigravity');statusNode.textContent=t(state?.authState==='waiting'?'Finish sign-in in your browser':session?.status==='waiting'?'Waiting for approval':session?.status==='running'?'Running':connected?'Connected':'Disconnected');
 statusNode.classList.toggle('running',session?.status==='running');
 connectButton.hidden=connected;connectButton.disabled=!!operation;disconnectButton.hidden=!connected;disconnectButton.disabled=!!busy;
 newButton.disabled=!connected||active||!!operation;refreshButton.disabled=!connected||!selected||active||!!operation;
 sendButton.disabled=!connected||active||!!operation;stopButton.hidden=!isRunning();stopButton.disabled=busy;
 attachButton.disabled=active||!!operation;composerText.disabled=!!busy;
 for(const select of modelControls.querySelectorAll('select'))select.disabled=!connected||active||!!operation;
 intro.hidden=!!selected;filePanel.hidden=!selected;
 const path=document.getElementById('agy-path');if(path&&document.activeElement!==path&&state?.executable)path.value=state.executable;
 const authKey=JSON.stringify([connected,state?.authState,state?.authMethods]);
 if(signIn.dataset.key!==authKey){signIn.dataset.key=authKey;signIn.replaceChildren();if(connected)for(const method of state.authMethods)signIn.append(btn(method.id==='oauth-personal'?'Sign in with Google':'Sign in with Gemini Enterprise',()=>act(async()=>{await api('/authenticate','POST',{methodId:method.id});await update()}),{disabled:!!operation||active}));}
 for(const button of signIn.querySelectorAll('button'))button.disabled=!!operation||active;
 if(state?.error)showError(Error(state.error));
}
function renderSession(result){
 const session=result.session;renderControls();
 const optionKey=JSON.stringify([session.configOptions,!!state?.activeSessionId,busy]);
 if(modelControls.dataset.key!==optionKey){modelControls.dataset.key=optionKey;modelControls.replaceChildren();
  for(const config of session.configOptions){
   const select=el('select',{'aria-label':t(config.name),disabled:!!state?.activeSessionId||busy||!state?.connected,onchange:e=>act(async()=>{await api('/sessions/'+selected+'/config','PUT',{configId:config.id,value:e.target.value});await update()})},config.options.map(option=>el('option',{value:option.value,text:option.name})));
   select.value=config.currentValue;modelControls.append(el('label',{},[text('span',config.name),select]));
  }
 }
 const accepted=pendingIntent&&events.some(event=>event.kind==='user'&&event.data.turnId===pendingIntent.id);
 if(accepted&&composerText.value===pendingIntent.text){composerText.value='';attachments=[];pendingIntent=null;remember();renderAttachments()}
 if(lastRendered!==String(cursor)){
  lastRendered=String(cursor);const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<150;
  const open=new Set([...transcript.querySelectorAll('details[open]')].map(n=>n.dataset.key));
  transcript.replaceChildren(...conversationNodes(events));for(const node of transcript.querySelectorAll('details'))if(open.has(node.dataset.key))node.open=true;
  if(nearBottom)requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight});
 }
 const permissionKey=JSON.stringify(result.permissions.map(p=>[p.id,p.turnId]));
 if(lastPermissions!==permissionKey){lastPermissions=permissionKey;permissionArea.replaceChildren(...result.permissions.map(p=>el('div',{class:'permission-card'},[text('p','Permission requested',{class:'eyebrow'}),el('h3',{text:p.title}),el('pre',{text:JSON.stringify(p.toolCall?.rawInput??{},null,2)}),el('div',{class:'permission-actions'},p.options.map(option=>btn(option.name,()=>act(async()=>{await api('/sessions/'+selected+'/permission','POST',{permissionId:p.id,turnId:p.turnId,optionId:option.optionId});await update()}))))])));}
}
function conversationNodes(entries){
 const blocks=[],tools=new Map();let assistant=null,thought=null;
 const output=(kind,value)=>{if(kind==='assistant'){if(!assistant){assistant={type:'assistant',text:''};blocks.push(assistant)}assistant.text+=value}else{if(!thought){thought={type:'thought',text:'',key:'thought-'+blocks.length};blocks.push(thought)}thought.text+=value}};
 for(const entry of entries){const data=entry.data;
  if(entry.kind==='user'){assistant=null;thought=null;blocks.push({type:'user',text:data.text,attachments:data.attachments})}
  else if(entry.kind==='agent'){
   if(data.sessionUpdate==='agent_message_chunk'&&data.content?.type==='text')output('assistant',data.content.text);
   else if(data.sessionUpdate==='agent_thought_chunk'&&data.content?.type==='text')output('thought',data.content.text);
   else if(['tool_call','tool_call_update'].includes(data.sessionUpdate)){
    assistant=null;thought=null;let block=tools.get(data.toolCallId);if(!block){block={type:'tool',key:data.toolCallId};tools.set(data.toolCallId,block);blocks.push(block)}Object.assign(block,data);
   }else if(data.sessionUpdate==='plan'){assistant=null;blocks.push({type:'plan',entries:data.entries??[]})}
  }else if(entry.kind==='error'){assistant=null;blocks.push({type:'error',text:t(data.message)})}
  else if(entry.kind==='turn_end'){assistant=null;thought=null;if(data.stopReason!=='completed'&&data.stopReason!=='end_turn')blocks.push({type:'notice',text:t('Turn ended')+': '+data.stopReason})}
 }
 return blocks.map(block=>{
  if(block.type==='user')return el('article',{class:'user-message'},[el('p',{text:block.text}),...(block.attachments??[]).map(a=>el('span',{class:'attachment-name',text:a.name}))]);
  if(block.type==='assistant'){const node=el('article',{class:'assistant-message markdown'});node.innerHTML=md.render(block.text,{session:selected});return node}
  if(block.type==='thought')return el('details',{class:'thought', 'data-key':block.key},[text('summary','Thinking'),el('div',{class:'thought-text',text:block.text})]);
  if(block.type==='tool')return el('details',{class:'tool-card','data-key':block.key},[el('summary',{},[el('span',{class:'tool-indicator '+(block.status??'pending')}),el('span',{text:block.title??t('Tool activity')}),el('span',{class:'tool-status',text:t(block.status??'pending')})]),...block.content?.map(c=>c.type==='content'&&c.content?.type==='text'?el('pre',{text:c.content.text}):c.type==='diff'?el('pre',{text:(c.oldText??'')+'\n→\n'+c.newText}):el('p',{text:t('Tool output available in the session workspace.')}))??[]]);
  if(block.type==='plan')return el('section',{class:'plan-card'},[text('h3','Agent plan'),el('ol',{},block.entries.map(e=>el('li',{'data-status':e.status,text:e.content})))]);
  return el('p',{class:block.type==='error'?'turn-error':'turn-notice',text:block.text});
 });
}
function renderAttachments(){attachmentStrip.replaceChildren(...attachments.map((a,index)=>el('span',{class:'attachment-chip'},[el('span',{text:a.file.name}),btn('Remove',()=>{attachments.splice(index,1);pendingIntent=null;remember();renderAttachments()},{'aria-label':t('Remove')+' '+a.file.name})])))}
fileInput.addEventListener('change',()=>{for(const file of fileInput.files){if(attachments.length>=8){showError(Error('Attach up to eight files.'));break}if(file.size===0||file.size>10*1024*1024){showError(Error('Choose a file between 1 byte and 10 MB.'));continue}attachments.push({file})}pendingIntent=null;fileInput.value='';remember();renderAttachments()});
composerText.addEventListener('input',()=>{if(pendingIntent?.text!==composerText.value)pendingIntent=null;remember()});
composerText.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!sendButton.disabled)form.requestSubmit()}});
function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).slice(String(reader.result).indexOf(',')+1));reader.onerror=()=>reject(Error('Could not read the attachment.'));reader.readAsDataURL(file)})}
async function send(){
 if(busy||state?.activeSessionId)return;
 if(!composerText.value.trim()&&!attachments.length)return;
 await act(async()=>{
  if(!selected){const draft=composerText.value,files=attachments;await newSession();composerText.value=draft;attachments=files;remember()}
  if(!pendingIntent)pendingIntent={id:crypto.randomUUID(),text:composerText.value,files:[...attachments]};
  const intent=pendingIntent;
  for(const attachment of intent.files)if(!attachment.id){const response=await api('/sessions/'+selected+'/attachments','POST',{name:attachment.file.name,mimeType:attachment.file.type||'application/octet-stream',data:await fileBase64(attachment.file)});attachment.id=response.id}
  await api('/sessions/'+selected+'/prompt','POST',{requestId:intent.id,text:intent.text,attachmentIds:intent.files.map(a=>a.id)});
  composerText.value='';attachments=[];pendingIntent=null;remember();renderAttachments();await update();composerText.focus();
 });
}
async function loadFiles(){
 if(!selected)return;const result=await api('/sessions/'+selected+'/files');
 fileList.replaceChildren(filesButton,...result.files.map(file=>el('a',{href:base+'/sessions/'+selected+'/file?path='+encodeURIComponent(file.path),text:file.path+' · '+(file.bytes/1024).toFixed(1)+' KB',download:''})),...!result.files.length?[text('p','Files created in this session will appear here.')]:[]);
}
const feed=new EventSource(base+'/events');feed.onmessage=()=>void update();feed.onerror=()=>{statusNode.textContent=t('Reconnecting to Chimeric…')};
window.addEventListener('beforeunload',()=>{feed.close()});
selected=new URL(location.href).searchParams.get('session');void update();
