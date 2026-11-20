import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const ja=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
function fixture(snapshot:any={},error='',failure?:string){
 const source=readFileSync(new URL('../src/class2-settings.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function '),translations:string[]=[],requests:any[]=[];
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const React={Fragment:'fragment',useState:(value:any)=>[typeof value==='function'?value():value,()=>{}],useRef:(value:any)=>({current:value}),useEffect(){},useCallback:(value:any)=>value};
 const module=runInNewContext(source+';useSnapshot=()=>({snapshot:fixtureSnapshot,error:fixtureError,busy:false,mutate:()=>{throw Error("No mutation belongs in this display test")}});({ConfidentialityControl,OutboundReviews,ConnectionEligibility,ReviewContent,ExactPayload,api})',{React,jsx,fixtureSnapshot:snapshot,fixtureError:error,globalThis:{ChimericI18n:{t:(value:string)=>{translations.push(value);return ja[value]??value}}},fetch:async(...args:any[])=>{requests.push(args);return {ok:!failure,json:async()=>({detail:failure})}},document:{cookie:''}});
 const expand=(node:any):any=>Array.isArray(node)?node.map(expand):node&&typeof node==='object'?typeof node.type==='function'?expand(node.type(node.props)):{...node,props:{...node.props,children:expand(node.props?.children)}}:node;
 const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const text=(node:any):string=>Array.isArray(node)?node.map(text).join(' '):node&&typeof node==='object'?text(node.props?.children):typeof node==='string'?node:'';
 const render=(name:string,props:any)=>{const tree=expand(module[name](props));return {tree,all:walk(tree),text:text(tree)}};
 return {render,translations,requests,api:module.api};
}
const frame=(extra:any={})=>({revision:0,frameId:'frame',rootFrameId:'frame',mode:'class2',main:'approved::model',reviewer:'approved::model',ready:false,models:[{qualifiedId:'approved::model',name:'Main model',connectionId:'approved',eligible:true}],reviews:[],...extra});
test('Japanese scoped settings translate fixed reason/error/evidence text while preserving model names',()=>{
 const reason='Class 2 model connections require HTTPS.',error='The protected model connection is unavailable.',f=fixture(frame({reason}),error),view=f.render('ConfidentialityControl',{frameId:'frame'});
 expect(view.text).toContain(ja[reason]);expect(view.all.find(node=>node.props?.role==='alert').props.children).toBe(ja[error]);expect(view.all.filter(node=>node.type==='option').map(node=>node.props.children)).toEqual(['Main model','Main model']);
 const connection=fixture({revision:0,connectionId:'approved',name:'Main model',allowedPurposes:[],automaticPurposes:[],eligible:false,reason,evidence:{status:'not-verified',zdr:'unknown',retention:'Provider policy has not been independently verified.',summary:'Your approval permits this connection to receive protected data. It does not establish zero data retention or institutional authorization.'}},error).render('ConnectionEligibility',{connectionId:'approved'});
 for(const value of ['not-verified','unknown','Provider policy has not been independently verified.','Your approval permits this connection to receive protected data. It does not establish zero data retention or institutional authorization.'])expect(connection.text).toContain(ja[value]);expect(connection.text).toContain(ja[reason]);expect(connection.all.find(node=>node.props?.role==='alert').props.children).toBe(ja[error]);
 expect(f.requests).toHaveLength(0);
});
test('Japanese review translates system disclosures but never transforms exact outgoing data or model-written explanations',()=>{
 const notice='This is a proposed transformed copy. Neither Chimeric nor the proposing model guarantees anonymity; inspect the exact payload before sending.',authentication='No account credential or browser cookie is attached by this keyless transport. Inspect the URL, headers and payload for identifying information.',ip='The destination sees the outgoing connection IP, which may belong to your network, proxy or remote server. Its exact value has not been looked up.',location='The destination may infer an approximate region from that IP. No location lookup is performed here; the approved payload may itself contain location information.',other='The destination sees the URL/query, headers and exact payload shown here, plus timing and transport metadata. DNS resolvers and intermediaries may also see destination metadata.';
 const payload={kind:'multipart',fields:[{name:'Main model',value:'Unknown'}],files:[{fieldName:'Speech model',filename:'Main model',contentType:'application/octet-stream',base64:Buffer.from('Unknown').toString('base64')}]},review={rationale:'The protected model connection is unavailable.',privacy:{kind:'decontextualized',summary:'Unknown',limitations:['Main model'],notice},destination:{url:'https://external.example/Unknown?query=Main%20model',encrypted:true},request:{method:'POST',headers:{'Main model':'Unknown'},payload,bodyBytes:7,bodySha256:'a'.repeat(64)},disclosures:{authentication,ip,location,other}};
 const original=JSON.stringify(review),f=fixture(),view=f.render('ReviewContent',{review});
 for(const message of [notice,authentication,ip,location,other])expect(view.text).toContain(ja[message]);expect(view.text).toContain(ja.decontextualized+': Unknown');
 const exact=view.all.filter(node=>node.type==='pre').map(node=>node.props.children);for(const value of [review.rationale,'POST '+review.destination.url,'Main model','Unknown',JSON.stringify(review.request.headers)])expect(exact).toContain(value);
 expect(view.all.find(node=>node.type==='strong').props.children).toBe('Main model');expect(view.all.find(node=>node.type==='textarea').props.value).toBe(payload.files[0].base64);
 expect(view.all.filter(node=>node.type==='div').some(node=>node.props.children==='Main model')).toBe(true);expect(view.all.filter(node=>node.type==='div').some(node=>node.props.children==='Speech model')).toBe(true);
 for(const data of [review.rationale,review.destination.url,'Main model','Speech model','Unknown',payload.files[0].base64])expect(f.translations).not.toContain(data);expect(JSON.stringify(review)).toBe(original);expect(f.requests).toHaveLength(0);
});
test('Japanese JSON and text payload displays preserve exact strings, spacing and field names',()=>{
 const f=fixture();for(const value of [{kind:'json',value:{'Main model':'Unknown',text:' \nSpeech model '}},{kind:'text',contentType:'text/plain',text:'Main model\nUnknown '}]){
  const view=f.render('ExactPayload',{payload:value}),encoded=value.kind==='json'?JSON.stringify(value.value):value.text;expect(view.all.find(node=>node.type==='pre').props.children).toBe(encoded);
 }
 for(const data of ['Main model','Unknown','Speech model'])expect(f.translations).not.toContain(data);
});
test('server API errors and review-list errors use the same fixed Japanese messages and retain unknown error fallback',async()=>{
 const failure='The connection URL, credential or configuration changed. Review the request again.',f=fixture(frame(),failure,failure);await expect(f.api('/api/local/confidentiality?frameId=frame')).rejects.toThrow(ja[failure]);const view=f.render('OutboundReviews',{frameId:'frame'});expect(view.all.find(node=>node.props?.role==='alert').props.children).toBe(ja[failure]);expect(f.requests).toHaveLength(1);
 const unknown='A future fixed server message.';expect(fixture(frame(),unknown).render('OutboundReviews',{frameId:'frame'}).text).toContain(unknown);
});
