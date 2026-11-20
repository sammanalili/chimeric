import {test,expect} from 'bun:test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from '@babel/parser';

const archive=resolve(import.meta.dir,'../../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz');

(existsSync(archive)?test:test.skip)('patched native SPA login performs a bounded full same-origin navigation to the local nonce gate',()=>{
 const original=Bun.spawnSync(['/usr/bin/tar','-xOf',archive,'./web-dist/assets/index-BgpYmw3d.js'],{stdout:'pipe',stderr:'pipe'});expect(original.exitCode).toBe(0);
 const transformed=Bun.spawnSync([process.execPath,resolve(import.meta.dir,'../tools/brand-frontend.mjs')],{env:{...process.env,BUN_BE_BUN:'1'},stdin:Buffer.from(JSON.stringify([{name:'./web-dist/assets/index-BgpYmw3d.js',text:original.stdout.toString()}])),stdout:'pipe',stderr:'pipe'});expect(transformed.exitCode).toBe(0);
 const text=JSON.parse(transformed.stdout.toString()).files[0].text;
 const functions=parse(text,{sourceType:'module'}).program.body.filter((node:any)=>node.type==='FunctionDeclaration'&&node.id?.name==='Bsn');expect(functions).toHaveLength(1);const node=functions[0] as any,component=text.slice(node.start,node.end);
 expect(component).not.toContain('provider=claude_ai');expect(component).not.toContain('Paste code instead');expect(component).not.toContain('/api/auth/login');
 function render(search:string){const effects:Array<()=>void>=[],navigations:string[]=[];const window={location:{origin:'http://localhost:18868',href:'http://localhost:18868/login'+search,search,replace:(url:string)=>navigations.push(url)}};const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};const result=new Function('window','f','a','jk','_t',component+';return Bsn();')(window,{useEffect:(callback:()=>void)=>effects.push(callback)},jsx,'LocalGate','Button');return{result,effects,navigations}}
 const first=render('?redirect='+encodeURIComponent('/projects/p/frames/f?panel=files')+'&nonce=spent');expect(first.effects).toHaveLength(1);first.effects[0]();expect(first.navigations).toHaveLength(1);const target=new URL(first.navigations[0]);expect(target.origin).toBe('http://localhost:18868');expect(target.pathname).toBe('/login');expect(target.searchParams.get('redirect')).toBe('/projects/p/frames/f?panel=files');expect(target.searchParams.has('nonce')).toBe(false);expect(target.searchParams.has('_chimeric_local_entry')).toBe(true);
 const fallback=render(target.search);fallback.effects[0]();expect(fallback.navigations).toHaveLength(0);const button=fallback.result.props.children.props.children.find((entry:any)=>entry?.type==='Button');expect(button).toBeDefined();button.props.onClick();expect(fallback.navigations).toHaveLength(1);expect(new URL(fallback.navigations[0]).origin).toBe(target.origin);
},15000);
