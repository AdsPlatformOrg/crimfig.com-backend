import { AuthorityPool } from './postgres-authority';
import { AdminActionProof,AdminDevice,adminActionDigest,adminActionQuorum } from './admin-actions';

/** Acknowledgement never changes a hold. Unfreeze is a distinct independently signed action. */
export class FinancialIncidentOperations {
  constructor(private readonly pool:AuthorityPool){}
  async act(proofs:AdminActionProof[],now=Date.now()):Promise<void>{
    if(!Array.isArray(proofs)||!proofs.length||proofs.length>20)throw new Error('Signed action required');
    const first=proofs[0],db=await this.pool.connect();
    try{
      await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='5s'");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('financial-authority-global-allocation',0))");
      const keys=await db.query(`SELECT d.key_id,d.actor_id,d.person_id,d.public_key FROM financial_authority.admin_devices d
        JOIN financial_authority.platform_admins a ON a.actor_id=d.actor_id AND a.person_id=d.person_id
        WHERE d.active=true AND a.active=true AND a.observed_at<=clock_timestamp() AND a.valid_until>clock_timestamp() FOR SHARE OF d,a`);
      const devices=new Map<string,AdminDevice>(keys.rows.map(r=>[r.key_id,{actorId:r.actor_id,personId:r.person_id,publicKey:r.public_key,active:true}]));
      const excluded=await db.query('SELECT person_id FROM financial_authority.incident_subjects WHERE incident_id=$1 OR incident_id=(SELECT reason FROM financial_authority.holds WHERE scope=$1)',[first.resource]);
      if(!adminActionQuorum(proofs,devices,now,new Set(excluded.rows.map(r=>r.person_id))))throw new Error('Independent action quorum required');
      const prior=await db.query('SELECT digest FROM financial_authority.admin_action_receipts WHERE request_id=$1 FOR UPDATE',[first.requestId]);
      const digest=adminActionDigest(first);
      if(prior.rows.length){if(prior.rows[0].digest!==digest)throw new Error('Action replay mismatch');await db.query('COMMIT');return;}
      if(first.action==='acknowledge'){
        const updated=await db.query(`UPDATE financial_authority.incidents SET acknowledged_by=COALESCE(acknowledged_by,$2),
          acknowledged_at=COALESCE(acknowledged_at,$3),state=CASE WHEN state='open' THEN 'acknowledged' ELSE state END WHERE id=$1 RETURNING id`,[first.resource,first.actorId,new Date(now)]);
        if(updated.rowCount!==1)throw new Error('Unknown incident');
      }else if(first.action==='freeze'){
        await db.query('INSERT INTO financial_authority.holds(scope,reason) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET active=true,reason=EXCLUDED.reason',[first.resource,first.requestId]);
      }else if(first.action==='unfreeze'){
        const result=await db.query('UPDATE financial_authority.holds SET active=false WHERE scope=$1 RETURNING scope',[first.resource]);
        if(result.rowCount!==1)throw new Error('Unknown hold');
      }else{
        const result=await db.query("UPDATE financial_authority.incidents SET state='resolved' WHERE id=$1 AND acknowledged_at IS NOT NULL RETURNING id",[first.resource]);
        if(result.rowCount!==1)throw new Error('Acknowledged incident required');
      }
      await db.query('INSERT INTO financial_authority.admin_action_receipts(request_id,digest,proofs) VALUES($1,$2,$3)',[first.requestId,digest,JSON.stringify(proofs)]);
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)',[first.resource,`admin_${first.action}:${first.requestId}`]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
