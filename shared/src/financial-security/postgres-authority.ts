import { createHash, randomUUID } from 'crypto';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';
import { AuthorityTransaction, ExecutionAuthorityStore, ExecutionRecord } from './executor';
import { FinancialProof, IndependentAssessment, WithdrawalBinding, withdrawalDigest, verifyFinancialProof } from './authorization';
import { AlertLease, financialAlertIntents, PriorityAlertStore, TrustedSecurityEvent } from './alerts';

/** Minimal pg-compatible port: the composition root must supply the isolated database pool. */
export interface AuthorityConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}
export interface AuthorityPool { connect(): Promise<AuthorityConnection> }
export class PostgresFinancialAuthority implements ExecutionAuthorityStore, PriorityAlertStore {
  constructor(private readonly pool: AuthorityPool) {}
  private async atomic<T>(work: (db: AuthorityConnection) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '3s'");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(db); await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async consumeWorkloadNonce(keyId: string, nonce: string): Promise<void> {
    await this.atomic(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`financial-ingress:${keyId}`]);
      const count = await db.query("SELECT count(*)::integer AS count FROM financial_authority.workload_nonces WHERE key_id=$1 AND observed_at > clock_timestamp()-interval '1 minute'", [keyId]);
      if (!Number.isSafeInteger(count.rows[0]?.count) || count.rows[0].count >= policy.privateRequestsPerMinute) throw new Error('Financial workload request limit reached');
      await db.query('INSERT INTO financial_authority.workload_nonces(key_id,nonce) VALUES($1,$2)', [keyId, nonce]);
    });
  }
  async prepare(binding: WithdrawalBinding): Promise<void> {
    const digest = withdrawalDigest(binding);
    await this.atomic(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`financial-intent:${binding.reference}`]);
      const existing = await db.query('SELECT digest FROM financial_authority.intents WHERE reference=$1 FOR UPDATE', [binding.reference]);
      if (existing.rows.length) {
        if (existing.rows[0].digest !== digest) throw new Error('Immutable withdrawal intent mismatch');
        return;
      }
      await db.query("INSERT INTO financial_authority.intents(reference,digest,binding,owner_proof) VALUES($1,$2,$3,'{}')", [binding.reference, digest, JSON.stringify(binding)]);
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [binding.reference, 'intent_prepared']);
    });
  }
  async attachProof(reference: string, proof: FinancialProof, keys: Readonly<Record<string, string>>, now: number): Promise<void> {
    await this.atomic(async db => {
      const { rows } = await db.query('SELECT * FROM financial_authority.intents WHERE reference=$1 FOR UPDATE', [reference]);
      const row = rows[0];
      let proofKeys=keys;
      if(proof?.purpose==='independent_review'){
        const device=await db.query('SELECT public_key FROM financial_authority.admin_devices WHERE key_id=$1 AND actor_id=$2 AND person_id=$3 AND active=true FOR SHARE',[proof.keyId,proof.actorId,proof.personId]);
        const publicKey=device.rows[0]?.public_key;
        if(!publicKey||Object.values(keys).includes(publicKey))throw new Error('Independent reviewer device required');
        proofKeys={[proof.keyId]:publicKey};
      }
      if (!row || row.state !== 'pending' || !proof || !['owner_authorization','independent_review'].includes(proof.purpose)
        || !verifyFinancialProof(proof, row.binding, proof.purpose, proofKeys, now)) throw new Error('Invalid withdrawal proof');
      if (proof.purpose === 'owner_authorization') {
        await db.query('UPDATE financial_authority.intents SET owner_proof=$2 WHERE reference=$1', [reference, JSON.stringify(proof)]);
      } else {
        const grants = await db.query('SELECT person_id FROM financial_authority.platform_admins WHERE actor_id=$1 AND active=true AND observed_at <= clock_timestamp() AND valid_until > clock_timestamp() FOR SHARE', [proof.actorId]);
        if (grants.rows[0]?.person_id !== proof.personId || proof.actorId === row.binding.ownerId || proof.personId === row.binding.ownerPersonId) throw new Error('Independent platform administrator required');
        const reviews = (row.reviews as FinancialProof[]).filter(p => p.actorId !== proof.actorId);
        if (reviews.length >= 20) throw new Error('Review capacity exceeded');
        await db.query('UPDATE financial_authority.intents SET reviews=$2 WHERE reference=$1', [reference, JSON.stringify([...reviews, proof])]);
      }
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [reference, `${proof.purpose}_recorded`]);
    });
  }
  async transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>): Promise<T> {
    return this.atomic(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('financial-authority-global-allocation',0))");
      const tx: AuthorityTransaction = {
        load: async reference => {
          const { rows } = await db.query('SELECT * FROM financial_authority.intents WHERE reference=$1 FOR UPDATE', [reference]);
          const row = rows[0]; if (!row) return null;
          if (withdrawalDigest(row.binding) !== row.digest) throw new Error('Intent evidence mismatch');
          return { binding: row.binding, ownerProof: row.owner_proof, reviews: row.reviews, state: row.state } as ExecutionRecord;
        },
        assess: async binding => {
          const { rows } = await db.query('SELECT assessment FROM financial_authority.assessments WHERE digest=$1 FOR SHARE', [withdrawalDigest(binding)]);
          if (!rows[0]) throw new Error('Independent assessment unavailable');
          const evidence = rows[0].assessment as IndependentAssessment;
          const holds = await db.query('SELECT scope FROM financial_authority.holds WHERE active=true AND scope=ANY($1::text[]) FOR SHARE',
            [['global', `environment:${binding.environment}`, `owner:${binding.ownerId}`, `destination:${binding.destinationKey}`]]);
          const totals = await db.query(`SELECT
            COALESCE(sum(amount_usd_cents) FILTER (WHERE owner_id=$1 AND allocated_at > clock_timestamp()-interval '24 hours'),0)::text AS owner_day,
            COALESCE(sum(amount_usd_cents) FILTER (WHERE destination_id=$2 AND allocated_at > clock_timestamp()-interval '24 hours'),0)::text AS destination_day,
            COALESCE(sum(amount_usd_cents) FILTER (WHERE allocated_at > clock_timestamp()-interval '1 hour'),0)::text AS platform_hour,
            COALESCE(sum(amount_usd_cents) FILTER (WHERE allocated_at > clock_timestamp()-interval '24 hours'),0)::text AS platform_day,
            COALESCE(sum(amount_usd_cents) FILTER (WHERE outstanding),0)::text AS outstanding
            FROM financial_authority.allocations WHERE environment=$3`, [binding.ownerPersonId, binding.destinationKey, binding.environment]);
          const t = totals.rows[0];
          return { ...evidence, frozen: evidence.frozen || holds.rows.length > 0,
            ownerDayUsdCents: Number(t.owner_day), destinationDayUsdCents: Number(t.destination_day),
            platformHourUsdCents: Number(t.platform_hour), platformDayUsdCents: Number(t.platform_day), outstandingUsdCents: Number(t.outstanding) };
        },
        platformAdmins: async () => new Map((await db.query('SELECT actor_id,person_id FROM financial_authority.platform_admins WHERE active=true AND observed_at <= clock_timestamp() AND valid_until > clock_timestamp() FOR SHARE')).rows.map(r => [r.actor_id, r.person_id])),
        reviewKeys:async()=>Object.fromEntries((await db.query('SELECT key_id,public_key FROM financial_authority.admin_devices WHERE active=true FOR SHARE')).rows.map(r=>[r.key_id,r.public_key])),
        consumedNonces: async nonces => new Set((await db.query('SELECT nonce FROM financial_authority.used_nonces WHERE nonce=ANY($1::text[])', [nonces])).rows.map(r => r.nonce)),
        claim: async (binding, nonces) => {
          const result = await db.query("UPDATE financial_authority.intents SET state='started' WHERE reference=$1 AND digest=$2 AND state='pending' RETURNING reference", [binding.reference, withdrawalDigest(binding)]);
          if (result.rowCount !== 1) throw new Error('Execution already claimed');
          await db.query('INSERT INTO financial_authority.allocations(reference,owner_id,destination_id,environment,amount_usd_cents) VALUES($1,$2,$3,$4,$5)',
            [binding.reference, binding.ownerPersonId, binding.destinationKey, binding.environment, binding.amountUsdCents]);
          for (const nonce of nonces) await db.query('INSERT INTO financial_authority.used_nonces(nonce,reference) VALUES($1,$2)', [nonce, binding.reference]);
        },
        audit: async (reference, event) => { await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [reference, event]); },
      };
      return work(tx);
    });
  }
  async recordSubmission(reference: string, digest: string, receipt: string): Promise<void> {
    await this.atomic(async db => {
      const result = await db.query("UPDATE financial_authority.intents SET state='submitted',provider_receipt=$3 WHERE reference=$1 AND digest=$2 AND state IN ('started','unknown') RETURNING reference", [reference, digest, receipt]);
      if (result.rowCount !== 1) throw new Error('Submission state conflict');
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [reference, 'provider_submission_accepted']);
    });
  }
  async recordUnknown(reference: string, digest: string): Promise<void> {
    await this.atomic(async db => {
      const result = await db.query("UPDATE financial_authority.intents SET state='unknown' WHERE reference=$1 AND digest=$2 AND state IN ('started','unknown') RETURNING reference", [reference, digest]);
      if (result.rowCount !== 1) throw new Error('Unknown execution state conflict; reconcile original reference');
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [reference, 'provider_outcome_unknown']);
    });
  }
  async ingestTrustedEvent(event: TrustedSecurityEvent, now: number): Promise<void> {
    const intents = financialAlertIntents(event, now);
    const id = `${event.environment}:${event.source}:${event.id}`;
    await this.atomic(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('financial-authority-global-allocation',0))");
      const result = await db.query('INSERT INTO financial_authority.incidents(id,source,event,severity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [id, event.source, JSON.stringify(event), intents[0].severity]);
      if (result.rowCount === 0) {
        const prior = await db.query('SELECT event FROM financial_authority.incidents WHERE id=$1', [id]);
        if (Object.keys(event).some(key => prior.rows[0]?.event?.[key] !== (event as any)[key])) throw new Error('Security event replay mismatch');
        return;
      }
      for (const intent of intents) await db.query(`INSERT INTO financial_authority.alert_deliveries
        (id,incident_id,recipient,environment,severity,submission_due_at,acknowledgement_due_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [intent.id, id, intent.recipient, event.environment, intent.severity, new Date(intent.submissionDueAt), new Date(intent.acknowledgementDueAt)]);
      // Source validation occurs before this method. Public requests cannot choose a containment scope.
      await db.query('INSERT INTO financial_authority.holds(scope,reason) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET active=true,reason=EXCLUDED.reason', [`environment:${event.environment}`, id]);
      await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [id, 'security_incident_contained']);
    });
  }
  async lease(limit: number, now: number): Promise<AlertLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(now)) throw new Error('Invalid lease request');
    return this.atomic(async db => {
      const token = randomUUID();
      const { rows } = await db.query(`WITH picked AS (
        SELECT id FROM financial_authority.alert_deliveries WHERE attempts < 5 AND
        ((state IN ('queued','failed','unknown') AND next_attempt_at <= $1) OR (state='attempting' AND lease_until <= $1))
        ORDER BY submission_due_at FOR UPDATE SKIP LOCKED LIMIT $2)
        UPDATE financial_authority.alert_deliveries d SET state='attempting',lease_token=$3,lease_until=$4,attempts=attempts+1
        FROM picked WHERE d.id=picked.id RETURNING d.*`, [new Date(now), limit, token, new Date(now + 30_000)]);
      return rows.map(r => ({ id: r.id, recipient: r.recipient, leaseToken: r.lease_token, environment: r.environment, incidentId: r.incident_id, severity: r.severity }));
    });
  }
  async accepted(id: string, token: string, providerId: string): Promise<void> {
    await this.deliveryResult(id, token, 'provider_accepted', null, providerId);
  }
  /** Run from a separately supervised watchdog process; never from the ordinary error-email queue. */
  async escalateUnacknowledged(now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid watchdog time');
    return this.atomic(async db => {
      const { rows } = await db.query(`SELECT i.id,i.event,i.severity,extract(epoch FROM COALESCE(i.last_escalated_at,i.created_at))*1000 AS last_notice_ms,
        COALESCE((SELECT max(d.generation) FROM financial_authority.alert_deliveries d WHERE d.incident_id=i.id),0) AS generation
        FROM financial_authority.incidents i WHERE i.acknowledged_at IS NULL AND i.state IN ('open','contained','investigating')
        AND i.created_at <= $1 ORDER BY i.created_at FOR UPDATE OF i SKIP LOCKED LIMIT 100`, [new Date(now - policy.acknowledgementTargetMs)]);
      let escalated = 0;
      for (const row of rows) {
        const previous = Number(row.generation);
        if (!Number.isSafeInteger(previous) || previous < 0 || previous >= policy.maximumReminderRounds) continue;
        // One round per five-minute slot, at most twelve rounds; overdue incidents remain open in console.
        if (!Number.isFinite(Number(row.last_notice_ms)) || now - Number(row.last_notice_ms) < policy.acknowledgementTargetMs) continue;
        const generation = previous + 1;
        for (const recipient of policy.recipients) {
          const id = createHash('sha256').update(JSON.stringify(['financial-escalation-v1', row.id, recipient, generation])).digest('hex');
          await db.query(`INSERT INTO financial_authority.alert_deliveries
            (id,incident_id,recipient,generation,environment,severity,submission_due_at,acknowledgement_due_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(incident_id,recipient,generation) DO NOTHING`,
            [id, row.id, recipient, generation, row.event.environment, row.severity, new Date(now + policy.alertSubmissionTargetMs), new Date(now + policy.acknowledgementTargetMs)]);
        }
        await db.query('UPDATE financial_authority.incidents SET last_escalated_at=$2 WHERE id=$1', [row.id, new Date(now)]);
        await db.query('INSERT INTO financial_authority.audit(reference,event) VALUES($1,$2)', [row.id, `unacknowledged_escalation_${generation}`]);
        escalated++;
      }
      return escalated;
    });
  }
  async failed(id: string, token: string, reason: 'submission_unknown' | 'test_delivery_disabled' | 'recipient_rejected'): Promise<void> {
    await this.deliveryResult(id, token, reason === 'test_delivery_disabled' ? 'test_disabled' : reason === 'recipient_rejected' ? 'failed' : 'unknown', reason, null);
  }
  private async deliveryResult(id: string, token: string, state: string, reason: string | null, providerId: string | null): Promise<void> {
    await this.atomic(async db => {
      const result = await db.query(`UPDATE financial_authority.alert_deliveries SET state=$3,failure_reason=$4,provider_id=$5,
        next_attempt_at=clock_timestamp()+interval '1 minute',lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND state='attempting' RETURNING id`, [id, token, state, reason, providerId]);
      if (result.rowCount !== 1) throw new Error('Alert lease expired or superseded');
    });
  }
}
