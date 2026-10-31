import { createHash } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, asc, sql } from 'drizzle-orm';
import { adsCampaigns, adsCreatives, adsCreativeStacks, adsCampaignChanges, adsCampaignMutations, adsCampaignSubmissions, crimfigGeoTargets } from '@crimfig/database/schema';

export interface MutationControl { expectedRevision: number; requestId: string }
export interface ReviewControl extends MutationControl { submissionId: string }
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function canonical(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function controlRequired(control?: Partial<MutationControl>): asserts control is MutationControl {
  if (!control || !uuidPattern.test(control.requestId || '') || typeof control.expectedRevision !== 'number' || !Number.isSafeInteger(control.expectedRevision) || control.expectedRevision < 1)
    throw new BadRequestException('A revision and valid request ID are required. Reload the campaign before saving.');
}
export function assertEditableCampaign(campaign: any) {
  if (['suspended', 'trash', 'cancelled', 'completed'].includes(campaign.status) || !['draft', 'rejected'].includes(campaign.moderationStatus) || campaign.currentSubmissionId)
    throw new ConflictException('Begin editing to withdraw the current review before changing this campaign.');
  if (campaign.submissionIntentId) throw new ConflictException('Check the pending submission before editing.');
}
export function currentApproval(c: any) {
  return Number.isSafeInteger(c.contentRevision) && c.contentRevision > 0 && Number.isSafeInteger(c.approvedRevision) &&
    c.moderationStatus === 'approved' && !!c.currentSubmissionId && c.currentSubmissionId === c.approvedSubmissionId &&
    c.approvedRevision === c.contentRevision && !c.submissionIntentId;
}
export function campaignCapabilities(c: any) {
  const terminal = ['suspended', 'trash', 'cancelled', 'completed'].includes(c.status);
  const editable = !terminal && ['draft', 'rejected'].includes(c.moderationStatus) && !c.currentSubmissionId && !c.submissionIntentId;
  return { canEdit: editable, canBeginEdit: !terminal && !editable && !c.submissionIntentId,
    canSubmit: editable, canActivate: !terminal && currentApproval(c) && c.status !== 'active',
    canPause: c.status === 'active', canTrash: !terminal && !c.submissionIntentId,
    blocker: terminal ? 'This campaign cannot be changed in its current state.' : c.submissionIntentId ? 'Check the pending submission before trying again.' :
      !editable ? 'Choose Edit and restart review to change this submission.' : null };
}
export class CampaignWorkflow {
  constructor(private readonly db: any) {}
  async lock(tx: any, id: string, owner?: string) {
    if (!uuidPattern.test(id) || (owner !== undefined && !uuidPattern.test(owner))) throw new NotFoundException('Campaign not found.');
    await tx.execute(sql`set local lock_timeout = '5s'`); await tx.execute(sql`set local statement_timeout = '8s'`);
    const [c] = await tx.select().from(adsCampaigns).where(owner === undefined ? eq(adsCampaigns.id, id) : and(eq(adsCampaigns.id, id), eq(adsCampaigns.advertiserId, owner))).for('update').limit(1);
    if (!c) throw new NotFoundException('Campaign not found.');
    return c;
  }
  async snapshot(tx: any, c: any) {
    const stacks = await tx.select().from(adsCreativeStacks).where(eq(adsCreativeStacks.campaignId, c.id)).orderBy(asc(adsCreativeStacks.position));
    const creatives = await tx.select().from(adsCreatives).where(eq(adsCreatives.campaignId, c.id)).orderBy(asc(adsCreatives.id));
    const targets = await tx.select().from(crimfigGeoTargets).where(sql`(${crimfigGeoTargets.ownerType} = 'campaign' AND ${crimfigGeoTargets.ownerId} = ${c.id}) OR (${crimfigGeoTargets.ownerType} = 'stack' AND ${crimfigGeoTargets.ownerId} IN (SELECT id FROM ads_creative_stacks WHERE campaign_id = ${c.id}))`).orderBy(asc(crimfigGeoTargets.id));
    // Omit clocks/approval bookkeeping so identical saves do not create content revisions.
    const strip = (r: any) => Object.fromEntries(Object.entries(r).filter(([k]) => !['updatedAt','createdAt','reviewedAt','reviewStatus','rejectionReason','primaryReviewerId','managerReviewerId','primaryReviewedAt','managerReviewedAt'].includes(k)));
    return canonical({ campaign: strip(c), stacks: stacks.map(strip), creatives: creatives.map(strip),
      targets:targets.map(({id,createdAt,updatedAt,...content}:any)=>content).sort((a:any,b:any)=>`${a.ownerType}:${a.ownerId}:${a.placeId}`.localeCompare(`${b.ownerType}:${b.ownerId}:${b.placeId}`)) });
  }
  async audit(tx: any, before: any, after: any, actorId: string, action: string, requestId: string, fields: string[]) {
    await tx.insert(adsCampaignChanges).values({ campaignId: after.campaign.id, actorId, requestId, action,
      priorRevision: before.campaign.contentRevision, contentRevision: after.campaign.contentRevision,
      previousSubmissionId: before.campaign.currentSubmissionId, submissionId: after.campaign.currentSubmissionId,
      beforeHash: fingerprint(before), afterHash: fingerprint(after), changedFields: fields,
      entityIds: [...new Set([after.campaign.id, ...before.stacks.map((s: any) => s.id), ...after.stacks.map((s: any) => s.id), ...before.creatives.map((s: any) => s.id), ...after.creatives.map((s: any) => s.id)])],
      beforeSnapshot: before, afterSnapshot: after });
  }
  async mutate(id: string, owner: string, action: string, control: MutationControl | undefined, payload: unknown, work: (tx: any, c: any) => Promise<any>, beginEdit = false) {
    controlRequired(control);
    const hash = fingerprint({ action, payload, expectedRevision: control.expectedRevision });
    return this.db.transaction(async (tx: any) => {
      const c = await this.lock(tx, id, owner);
      const [prior] = await tx.select().from(adsCampaignMutations).where(and(eq(adsCampaignMutations.campaignId,id),eq(adsCampaignMutations.actorId,owner),eq(adsCampaignMutations.requestId,control.requestId))).limit(1);
      if (prior) { if(prior.purgedAt)throw new ConflictException('This request receipt has been archived. Reload the campaign.');if (prior.fingerprint !== hash) throw new ConflictException('This request ID was used for different changes.'); return prior.result; }
      if (c.contentRevision !== control.expectedRevision) throw new ConflictException('This campaign changed. Reload before saving.');
      if (!beginEdit) assertEditableCampaign(c);
      const before = await this.snapshot(tx,c);
      const result = await work(tx,c);
      const [latest] = await tx.select().from(adsCampaigns).where(eq(adsCampaigns.id,id)).limit(1);
      let after = await this.snapshot(tx,latest);
      let revision = c.contentRevision;
      if (fingerprint(before) !== fingerprint(after)) {
        revision++;
        await tx.update(adsCampaigns).set({ contentRevision:revision, approvedRevision:null, approvedSubmissionId:null, updatedAt:new Date() }).where(eq(adsCampaigns.id,id));
        after.campaign.contentRevision = revision; after.campaign.approvedRevision = null; after.campaign.approvedSubmissionId = null;
        await this.audit(tx,before,after,owner,action,control.requestId, Object.keys((payload || {}) as object).filter(k => !['requestId','expectedRevision'].includes(k)));
      }
      const output = { ...result, contentRevision:revision };
      await tx.insert(adsCampaignMutations).values({ campaignId:id,actorId:owner,requestId:control.requestId,action,fingerprint:hash,result:output });
      return output;
    });
  }
}
