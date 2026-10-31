import { createHash, createPublicKey, verify } from 'crypto';
export interface AdminActionProof {
  keyId:string; actorId:string; personId:string; action:'acknowledge'|'freeze'|'unfreeze'|'resolve';
  resource:string; requestId:string; issuedAt:number; expiresAt:number; signature:string;
}
export interface AdminDevice { actorId:string;personId:string;publicKey:string;active:boolean }
export function adminActionMessage(p:Omit<AdminActionProof,'signature'>):Buffer {
  return Buffer.from(JSON.stringify(['financial-admin-action-v1',p.keyId,p.actorId,p.personId,p.action,p.resource,p.requestId,p.issuedAt,p.expiresAt]));
}
/** Device public keys are independently provisioned; Auth's general signing key cannot mint these approvals. */
export function validAdminAction(p:AdminActionProof, devices:ReadonlyMap<string,AdminDevice>,now:number):boolean {
  try {
    const d=devices.get(p.keyId);
    if(!d?.active||d.actorId!==p.actorId||d.personId!==p.personId||!['acknowledge','freeze','unfreeze','resolve'].includes(p.action)
      ||!p.resource||p.resource.length>256||!/^[a-f0-9-]{36}$/i.test(p.requestId)
      ||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now||p.expiresAt<=now
      ||p.expiresAt<=p.issuedAt||p.expiresAt-p.issuedAt>300000||!/^[A-Za-z0-9_-]{86}$/.test(p.signature))return false;
    const key=createPublicKey(d.publicKey);
    return key.asymmetricKeyType==='ed25519'&&verify(null,adminActionMessage(p),key,Buffer.from(p.signature,'base64url'));
  }catch{return false;}
}
export function adminActionQuorum(proofs:AdminActionProof[],devices:ReadonlyMap<string,AdminDevice>,now:number,excludedPeople:ReadonlySet<string>):boolean {
  if(!proofs.length)return false;
  const first=proofs[0],people=new Set<string>();
  for(const p of proofs){
    if(p.action!==first.action||p.resource!==first.resource||p.requestId!==first.requestId||excludedPeople.has(p.personId)||!validAdminAction(p,devices,now))continue;
    people.add(p.personId);
  }
  return people.size>=(['unfreeze','resolve'].includes(first.action)?2:1);
}
export const adminActionDigest=(p:AdminActionProof)=>createHash('sha256').update(adminActionMessage(p)).digest('hex');
