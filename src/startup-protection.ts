export type ProtectionEvidence=Readonly<{verified:boolean;reason?:string}>;

/** Latches an unverified startup for the lifetime of the daemon. A process
 * cannot gain trust after files appear underneath it. A verified startup is
 * rechecked on every use so mutation still removes trust immediately. */
export function latchProtectionEvidence(read:()=>ProtectionEvidence){
 const initial=Object.freeze({...read()});
 const current=initial.verified?()=>read():()=>initial;
 return Object.freeze({initial,current});
}
