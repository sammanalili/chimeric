/** Vendor product services remain blocked independently of model connections. */
export const bannedHost=(host:string)=>{
 const normalized=host.toLowerCase().replace(/\.$/,'');
 return ['anthropic.com','anthropic.ai','claude.ai','claude.com'].some(domain=>normalized===domain||normalized.endsWith('.'+domain));
};
