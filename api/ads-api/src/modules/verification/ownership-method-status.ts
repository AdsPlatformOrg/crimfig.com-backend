import {createHash} from 'crypto';
export const proofTokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function ownershipMethodStatuses(website:any,checks:any[],now=Date.now()){
  const result:any={};
  for(const method of ['html_meta','dns_txt']){
    const check=checks.find(row=>row.entityId===website.id&&row.dimension===`ownership_check_${method}`&&row.reason===proofTokenHash(website.verificationToken));
    const legacyConfirmed=website.verificationStatus==='verified'&&website.verificationMethod===(method==='html_meta'?'html_file_and_meta_tag':'dns_txt');
    const checkedAt=check?.createdAt??(legacyConfirmed?website.verifiedAt:null);
    const confirmed=check?check.toState==='verified':legacyConfirmed;
    const expiresAt=check&&confirmed?new Date(new Date(check.createdAt).getTime()+30*86400000):legacyConfirmed?website.verificationExpiresAt:null;
    result[method]={status:confirmed?(expiresAt&&new Date(expiresAt).getTime()>now?'verified':'expired'):'not_verified',checkedAt};
  }
  return result;
}
