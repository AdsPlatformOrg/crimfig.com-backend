import { ConflictException, Inject, Injectable, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { ChallengeProposal, FinancialChallenge, FinancialProofIssuer, FINANCIAL_SECURITY_POLICY as policy,
  proposalMessage, verifyChallengeProposal, signPrivateRequest, readPrivateResponse } from '@crimfig/shared';
import { DATABASE_TOKEN } from '../database/database.module';
import { MfaService } from '../mfa/mfa.service';
import { config } from '../../config/config';

@Injectable()
export class FinancialAuthorizationService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>, private readonly mfa: MfaService) {}
  async begin(actorId: string, reference: string) {
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new UnauthorizedException('Invalid withdrawal reference');
    let origin: string;
    try {
      const url = new URL(config.FINANCIAL_AUTH.AUTHORITY_URL || '');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      origin = url.origin;
    } catch { throw new ServiceUnavailableException('Independent financial authority is unavailable'); }
    const key = config.FINANCIAL_AUTH.WORKLOAD_PRIVATE_KEY, keyId = config.FINANCIAL_AUTH.WORKLOAD_KEY_ID;
    if (!key || !keyId) throw new ServiceUnavailableException('Auth financial workload identity is unavailable');
    const path = '/internal/v1/withdrawals/challenge';
    const request = signPrivateRequest(path, { userId: actorId, reference }, keyId, key);
    const response = await fetch(`${origin}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw new ServiceUnavailableException('Withdrawal challenge could not be retrieved');
    const text = await response.text();
    if (Buffer.byteLength(text) > 65536) throw new ServiceUnavailableException('Invalid challenge response');
    const proposal = readPrivateResponse(JSON.parse(text), request, this.keys()) as ChallengeProposal;
    if (proposal.binding?.reference !== reference) throw new UnauthorizedException('Withdrawal challenge reference mismatch');
    return this.register(actorId, proposal);
  }
  private keys(): Record<string, string> {
    try {
      const keys = JSON.parse(config.FINANCIAL_AUTH.AUTHORITY_PUBLIC_KEYS);
      if (!keys || Array.isArray(keys) || typeof keys !== 'object' || !Object.keys(keys).length
        || Object.values(keys).some(k => typeof k !== 'string')) throw new Error();
      return keys;
    } catch { throw new ServiceUnavailableException('Financial authorization trust is not configured'); }
  }
  private async lock(tx: any, actorId: string) {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`financial-auth:${actorId}`},0))`);
  }
  private async eligible(tx: any, challenge: FinancialChallenge, now: number, checkAttempts = true): Promise<boolean> {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, challenge.actorId)).for('share');
    const [identity] = await tx.select().from(schema.financialIdentities).where(eq(schema.financialIdentities.userId, challenge.actorId)).for('share');
    if (user?.status !== 'ACTIVE' || user.mfaEnabled !== true || !identity?.active || identity.personId !== challenge.personId
      || !identity.recoveryClearedAt || new Date(identity.recoveryClearedAt).getTime() > now) return false;
    if (challenge.purpose === 'independent_review') {
      // Financial review explicitly excludes inherited Ads grants.
      let grants: any; try { grants = JSON.parse(config.FINANCIAL_AUTH.EXPLICIT_PLATFORM_GRANTS); } catch { return false; }
      if (!Array.isArray(grants?.[challenge.actorId]) || !grants[challenge.actorId].includes('super_admin')) return false;
    }
    if (!checkAttempts) return true;
    const [attempts] = await tx.select({ count: sql<number>`coalesce(sum(${schema.financialChallenges.attempts}),0)::integer` })
      .from(schema.financialChallenges).where(and(eq(schema.financialChallenges.actorId, challenge.actorId),
        gte(schema.financialChallenges.createdAt, new Date(now - policy.proofLifetimeMs))));
    return Number.isSafeInteger(attempts?.count) && attempts.count < 5;
  }
  private challenge(p: ChallengeProposal, attempts = 0, consumed = false): FinancialChallenge {
    return { id: p.challengeId, actorId: p.actorId, personId: p.personId, purpose: p.purpose,
      binding: p.binding, expiresAt: p.expiresAt, attempts, consumed };
  }
  async register(actorId: string, proposal: ChallengeProposal) {
    const now = Date.now();
    if (!verifyChallengeProposal(proposal, actorId, this.keys(), now)) throw new UnauthorizedException('Withdrawal proposal is invalid or expired');
    return this.db.transaction(async tx => {
      await this.lock(tx, actorId);
      const [existing] = await tx.select().from(schema.financialChallenges).where(eq(schema.financialChallenges.id, proposal.challengeId)).for('update');
      if (existing && (existing.actorId !== actorId || !proposalMessage(existing.proposal as ChallengeProposal).equals(proposalMessage(proposal)))) throw new ConflictException('Challenge identity mismatch');
      if (!await this.eligible(tx, this.challenge(proposal), now)) throw new UnauthorizedException('Financial authorization is unavailable for this account');
      if (!existing) {
        const [recent] = await tx.select({ count: sql<number>`count(*)::integer` }).from(schema.financialChallenges)
          .where(and(eq(schema.financialChallenges.actorId, actorId), gte(schema.financialChallenges.createdAt, new Date(now - policy.proofLifetimeMs))));
        if (recent.count >= 5) throw new UnauthorizedException('Wait before requesting another financial challenge');
        await tx.insert(schema.financialChallenges).values({ id: proposal.challengeId, actorId, proposal, expiresAt: new Date(proposal.expiresAt) });
      }
      return { challengeId: proposal.challengeId, purpose: proposal.purpose, binding: proposal.binding,
        expiresAt: proposal.expiresAt, consumed: !!existing?.consumedAt };
    });
  }
  async confirm(actorId: string, id: string, code: string) {
    const privateKey = config.FINANCIAL_AUTH.SIGNING_PRIVATE_KEY;
    const keyId = config.FINANCIAL_AUTH.SIGNING_KEY_ID;
    if (!privateKey || !keyId) throw new ServiceUnavailableException('Financial signing authority is not configured');
    const issuer = new FinancialProofIssuer({ transaction: work => this.db.transaction(async tx => {
      await this.lock(tx, actorId);
      return work({
        loadForUpdate: async challengeId => {
          const [row] = await tx.select().from(schema.financialChallenges).where(and(eq(schema.financialChallenges.id, challengeId), eq(schema.financialChallenges.actorId, actorId))).for('update');
          if (!row) return null;
          const p = row.proposal as ChallengeProposal;
          if (!verifyChallengeProposal(p, actorId, this.keys(), Date.now())) return null;
          return this.challenge(p, row.attempts, !!row.consumedAt);
        },
        eligible: (c, now) => this.eligible(tx, c, now),
        incrementAttempts: async challengeId => { await tx.update(schema.financialChallenges).set({ attempts: sql`${schema.financialChallenges.attempts}+1` }).where(eq(schema.financialChallenges.id, challengeId)); },
        consumeFinancialTotp: (actor, value, now) => this.mfa.consumeFinancialTotp(tx, actor, value, now),
        complete: async (challengeId, proof) => { await tx.update(schema.financialChallenges).set({ proof, consumedAt: new Date() }).where(eq(schema.financialChallenges.id, challengeId)); },
      });
    }) }, keyId, privateKey);
    try { return await issuer.confirm(actorId, id, code); }
    catch (error) {
      if (error instanceof Error && error.message === 'Transaction authorization rejected or expired') throw new UnauthorizedException(error.message);
      throw new ServiceUnavailableException('Financial authorization could not be confirmed');
    }
  }
  /** Lost responses recover the same proof, never mint a second authorization or consume another TOTP. */
  async read(actorId: string, id: string) {
    return this.db.transaction(async tx => {
      await this.lock(tx, actorId);
      const [row] = await tx.select().from(schema.financialChallenges).where(and(eq(schema.financialChallenges.id, id), eq(schema.financialChallenges.actorId, actorId))).for('share');
      if (!row) throw new UnauthorizedException('Financial challenge is unavailable');
      const proposal = row.proposal as ChallengeProposal;
      const now = Date.now();
      if (!verifyChallengeProposal(proposal, actorId, this.keys(), now)
        || !await this.eligible(tx, this.challenge(proposal), now, false)) throw new UnauthorizedException('Financial challenge is unavailable or expired');
      return { challengeId: id, expiresAt: proposal.expiresAt, binding: proposal.binding,
        state: row.consumedAt ? 'confirmed' : 'awaiting_confirmation', proof: row.proof || null };
    });
  }
}
