import {expect,test} from 'bun:test';
import {latchProtectionEvidence} from '../src/startup-protection';

test('an unverified startup cannot become Class 2 ready during the daemon lifetime',()=>{
 let value={verified:false,reason:'missing receipt'};const latch=latchProtectionEvidence(()=>value);
 expect(latch.initial).toEqual({verified:false,reason:'missing receipt'});value={verified:true,reason:'replaced underneath process'};
 expect(latch.current()).toEqual({verified:false,reason:'missing receipt'});
});

test('a verified startup is rechecked and loses Class 2 readiness on mutation',()=>{
 let value:{verified:boolean;reason?:string}={verified:true};const latch=latchProtectionEvidence(()=>value);
 expect(latch.current()).toEqual({verified:true});value={verified:false,reason:'sealed file changed'};
 expect(latch.current()).toEqual({verified:false,reason:'sealed file changed'});
});
