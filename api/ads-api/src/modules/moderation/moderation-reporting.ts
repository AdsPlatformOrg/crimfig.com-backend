import { sql, type SQL } from 'drizzle-orm';

/** One work-item relation for queue membership, age evidence and aggregate counts.
 * No joins to child collections or mutable counter caches. Each target occurs once.
 */
export function pendingModerationWork(): SQL {
  return sql`WITH current_submissions AS (
    SELECT c.id AS campaign_id, s.id AS submission_id, c.content_revision, s.submitted_at,
      c.moderation_status, s.snapshot->'scope' AS scope, s.snapshot
    FROM ads_campaigns c JOIN ads_campaign_submissions s ON s.campaign_id = c.id
      AND s.content_revision = c.content_revision AND (s.id = c.current_submission_id OR
        (s.snapshot->'scope' IS NOT NULL AND c.moderation_status = 'approved'
          AND c.current_submission_id = c.approved_submission_id AND c.approved_revision = c.content_revision))
    WHERE s.state = 'submitted' AND c.submission_intent_id IS NULL
      AND c.status NOT IN ('suspended','trash','cancelled','completed')
  ), work AS (
    SELECT 'campaign'::text AS target_type, c.campaign_id AS target_id, c.campaign_id,
      c.submission_id, c.content_revision, c.submitted_at,
      CASE WHEN c.moderation_status = 'pending_primary_review' THEN 'reviewer' ELSE 'manager' END AS stage
    FROM current_submissions c WHERE c.scope IS NULL AND c.moderation_status IN ('pending_primary_review','pending_manager_approval')
    UNION ALL
    SELECT 'stack', t.id, c.campaign_id, c.submission_id, c.content_revision, c.submitted_at,
      CASE WHEN t.review_status = 'pending' THEN 'reviewer' ELSE 'manager' END
    FROM current_submissions c JOIN ads_creative_stacks t ON t.campaign_id = c.campaign_id
    WHERE t.archived = false AND t.review_status IN ('pending','pending_manager_approval')
      AND ((c.scope IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot->'stacks') item WHERE item->>'id'=t.id::text)) OR c.scope->'stackIds' ? t.id::text)
    UNION ALL
    SELECT 'creative', t.id, c.campaign_id, c.submission_id, c.content_revision, c.submitted_at,
      CASE WHEN t.review_status = 'pending' THEN 'reviewer' ELSE 'manager' END
    FROM current_submissions c JOIN ads_creatives t ON t.campaign_id = c.campaign_id
    WHERE t.status = 'active' AND t.review_status IN ('pending','pending_manager_approval')
      AND ((c.scope IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot->'creatives') item WHERE item->>'id'=t.id::text)) OR c.scope->'creativeIds' ? t.id::text)
  )
  SELECT w.*, CASE WHEN w.stage = 'reviewer' THEN w.submitted_at ELSE (
    SELECT max(d.created_at) FROM ads_moderation_decisions d
    WHERE d.target_type::text = w.target_type AND d.target_id = w.target_id
      AND d.submission_id = w.submission_id AND d.content_revision = w.content_revision
      AND d.stage = 'primary' AND d.decision = 'approved'
  ) END AS stage_started_at FROM work w`;
}

export function queueSubmission(type: string, id: SQL, stage: string): SQL {
  return sql<string>`(SELECT submission_id FROM (${pendingModerationWork()}) pending WHERE target_type = ${type} AND target_id = ${id} AND stage = ${stage})`;
}

export function matchesReviewSubmission(campaign: any, submission: any, type: string, id: string): boolean {
  if (!submission || submission.state !== 'submitted' ||
      submission.contentRevision !== campaign.contentRevision || campaign.submissionIntentId) return false;
  if (submission.id === campaign.currentSubmissionId && (submission.campaignId === undefined || submission.campaignId === campaign.id)) return true;
  if (submission.campaignId !== campaign.id) return false;
  const ids = submission.snapshot?.scope?.[type === 'creative' ? 'creativeIds' : type === 'stack' ? 'stackIds' : ''];
  return campaign.moderationStatus === 'approved' && campaign.currentSubmissionId === campaign.approvedSubmissionId &&
    campaign.approvedRevision === campaign.contentRevision && Array.isArray(ids) && ids.includes(id);
}

export function queueMembership(type:string, id:SQL, stage:string): SQL {
  return sql`${id} IN (SELECT target_id FROM (${pendingModerationWork()}) pending WHERE target_type = ${type} AND stage = ${stage})`;
}
export function queueClock(type:string, id:SQL, stage:string): SQL {
  return sql`(SELECT json_build_object('submittedAt', submitted_at, 'stageStartedAt', stage_started_at)
    FROM (${pendingModerationWork()}) pending WHERE target_type = ${type} AND target_id = ${id} AND stage = ${stage})`;
}

export function elapsedSeconds(start:unknown, asOf:unknown, notBefore?:unknown):number|null {
  const parse=(v:unknown)=>v instanceof Date?v.getTime():typeof v==='string'&&/T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)?Date.parse(v):NaN;
  const time=parse(start), now=parse(asOf), floor=notBefore===undefined?time:parse(notBefore);
  return Number.isFinite(time)&&Number.isFinite(now)&&Number.isFinite(floor)&&floor<=time&&time<=now ? Math.floor((now-time)/1000):null;
}
