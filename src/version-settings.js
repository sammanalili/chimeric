import {r as React,j as jsx} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';

export function chimericVersionLabel(value){
 return value?.product==='Chimeric'&&typeof value.version==='string'&&value.version.length<=96&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)?'Chimeric '+value.version:'Chimeric';
}

export function VersionSettings(){
 const [version,setVersion]=React.useState(null);
 React.useEffect(()=>{
  let active=true;const controller=new AbortController();
  void fetch('/api/local/version',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
   .then(response=>response.ok?response.json():null)
   .then(value=>{if(active)setVersion(value)})
   .catch(()=>{});
  return()=>{active=false;controller.abort()};
 },[]);
 return jsx.jsx('p',{'data-testid':'chimeric-build-version',className:'mb-3 text-footnote text-text-400',children:chimericVersionLabel(version)});
}
