import { AuthorityPool } from './postgres-authority';
import { IndependentFinancialObservation, assessFinancialObservation } from './risk-observations';
import { WithdrawalBinding, withdrawalDigest } from './authorization';

export interface FinancialEvidenceSource {
  observe(binding: WithdrawalBinding): Promise<IndependentFinancialObservation>;
}
/** Run under a collector identity with assessment write permission; never grant this to the executor. */
export class FinancialRiskCollector {
  constructor(private readonly pool: AuthorityPool, private readonly source: FinancialEvidenceSource) {}
  async collect(binding: WithdrawalBinding, now = Date.now()): Promise<void> {
    const observation = await this.source.observe(binding);
    const assessment = assessFinancialObservation(binding, observation, now);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN'); await db.query("SET LOCAL statement_timeout='5s'");
      await db.query(`INSERT INTO financial_authority.assessments(digest,assessment,observed_at) VALUES($1,$2,$3)
        ON CONFLICT(digest) DO UPDATE SET assessment=EXCLUDED.assessment,observed_at=EXCLUDED.observed_at
        WHERE financial_authority.assessments.observed_at < EXCLUDED.observed_at`,
        [withdrawalDigest(binding),JSON.stringify(assessment),new Date(observation.observedAt)]);
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
}
