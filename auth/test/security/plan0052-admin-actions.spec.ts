import {generateKeyPairSync,sign} from 'crypto';
import {AdminActionProof,AdminDevice,adminActionMessage,adminActionQuorum} from '../../../shared/src/financial-security/admin-actions';
describe('independent device administrative actions',()=>{
  const now=1800000000000,devices=new Map<string,AdminDevice>();
  function proof(actor:string,person:string,action:AdminActionProof['action']='unfreeze'){
    const pair=generateKeyPairSync('ed25519');devices.set(actor,{actorId:actor,personId:person,active:true,publicKey:pair.publicKey.export({format:'pem',type:'spki'}).toString()});
    const p:AdminActionProof={keyId:actor,actorId:actor,personId:person,action,resource:'environment:live',requestId:'11111111-1111-4111-8111-111111111111',issuedAt:now,expiresAt:now+60000,signature:''};
    p.signature=sign(null,adminActionMessage(p),pair.privateKey).toString('base64url');return p;
  }
  beforeEach(()=>devices.clear());
  test('one reviewer or two accounts of one person cannot unfreeze',()=>{
    const a=proof('a','person'),b=proof('b','person');expect(adminActionQuorum([a],devices,now,new Set())).toBe(false);expect(adminActionQuorum([a,b],devices,now,new Set())).toBe(false);
  });
  test('suspected actors, changed resources, expired signatures and unknown keys cannot authorize',()=>{
    const a=proof('a','a'),b=proof('b','b');expect(adminActionQuorum([a,b],devices,now,new Set(['a']))).toBe(false);
    expect(adminActionQuorum([a,{...b,resource:'global'}],devices,now,new Set())).toBe(false);
    expect(adminActionQuorum([a,b],devices,now+60000,new Set())).toBe(false);
    expect(adminActionQuorum([a,b],new Map(),now,new Set())).toBe(false);
  });
  test('two distinct independent device signatures can authorize the same unfreeze',()=>{
    expect(adminActionQuorum([proof('a','a'),proof('b','b')],devices,now,new Set())).toBe(true);
  });
  test('acknowledgement needs one independent signature and cannot be repurposed as unfreeze',()=>{
    const p=proof('a','a','acknowledge');expect(adminActionQuorum([p],devices,now,new Set())).toBe(true);
    expect(adminActionQuorum([{...p,action:'unfreeze'}],devices,now,new Set())).toBe(false);
  });
});
