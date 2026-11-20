// All composer and settings consumers import this exact same-origin module.
// One EventSource leaves the browser's HTTP/1 connections available for reads.
const providerEventListeners=new Set();
let providerEventSource;
export function subscribeProviderEvents(callback){
 if(typeof callback!=='function')throw new TypeError('A provider-events callback is required.');
 const subscription={callback};providerEventListeners.add(subscription);
 if(!providerEventSource&&typeof EventSource!=='undefined'){
  try{
   const source=new EventSource('/api/local/connections/events');providerEventSource=source;
   source.onmessage=event=>{
    if(providerEventSource!==source)return;
    for(const listener of [...providerEventListeners])if(providerEventListeners.has(listener)){
     try{listener.callback(event)}catch{/* A stale view must not interrupt the other mounted consumers. */}
    }
   };
   // EventSource owns reconnection. Recreating it on errors would add sockets.
  }catch(error){providerEventListeners.delete(subscription);throw error}
 }
 return()=>{
  if(!providerEventListeners.delete(subscription)||providerEventListeners.size)return;
  const source=providerEventSource;providerEventSource=undefined;
  if(source){source.onmessage=null;source.close()}
 };
}
