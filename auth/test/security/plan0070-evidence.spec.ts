import { CfigService } from "../../../api/ads-api/src/modules/cfig/cfig.service";
import { canonicalHousePolicy } from "../../../api/ads-api/src/modules/cfig/cfig-allocation";
import {
  adDigest,
  evidenceSignature,
} from "../../../shared/src/ad-authority-policy";
const eventId = "00000000-0000-4000-8000-000000000001";
const key = process.env.ADS_EVIDENCE_HASH_SECRET,
  keyId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
beforeEach(() => {
  process.env.ADS_EVIDENCE_HASH_SECRET =
    "unit-only-house-evidence-secret-at-least-32-bytes";
  process.env.ADS_EVIDENCE_HASH_KEY_ID = "test";
});
afterEach(() => {
  if (key === undefined) delete process.env.ADS_EVIDENCE_HASH_SECRET;
  else process.env.ADS_EVIDENCE_HASH_SECRET = key;
  if (keyId === undefined) delete process.env.ADS_EVIDENCE_HASH_KEY_ID;
  else process.env.ADS_EVIDENCE_HASH_KEY_ID = keyId;
});
function fixture(patch: any = {}) {
  const config = canonicalHousePolicy(),
    terms = {
      version: config.policyVersion,
      termsVersion: config.policyVersion,
      effectiveFrom: "2026-11-01T00:00:00Z",
      houseRewards: config,
    };
  const event: any = {
    id: eventId,
    event_id: "client",
    serve_id: "serve",
    promoter_id: "promoter",
    website_id: "site",
    slot_id: "slot",
    type: patch.click ? "click" : "viewable_impression",
    created_at: new Date("2026-11-01T01:00:01Z"),
    visible_ratio: "0.7500",
    duration_ms: 1500,
    measurable: true,
    assessment_status: "provisional",
    financial_eligibility: "invalid",
    verification_version: 0,
    page_view_id: "page",
    slot_instance_id: "instance",
    opportunity_id: "opportunity",
    sdk_init_id: "sdk",
    ...patch.event,
  };
  const context = {
    websitePolicy: "approved",
    ownershipStatus: "verified",
    ownershipExpiresAt: "2099-01-01T00:00Z",
    programAuthorized: true,
    policyId: "policy",
    policyDigest: adDigest(terms),
    ...patch.context,
  };
  const serve: any = {
    id: "serve",
    served_at: new Date("2026-11-01T01:00Z"),
    request_id: "request",
    inventory_class: "house",
    delivery_mode: "normal",
    promoter_id: "promoter",
    website_id: "site",
    slot_id: "slot",
    billing_price_nanos: "0",
    content_snapshot: { adType: "image", houseRewardContext: context },
    ...patch.serve,
  };
  const payload: any = {
    eventId: "client",
    serveId: "serve",
    type: event.type,
    serverReceivedAt: event.created_at.toISOString(),
    visibleRatio: event.visible_ratio,
    durationMs: event.duration_ms,
    measurable: true,
    assessmentStatus: event.assessment_status,
    financialEligibility: "invalid",
    verificationVersion: 0,
    websiteId: "site",
    slotId: "slot",
    instanceClaims: {
      pageViewId: event.page_view_id,
      slotInstanceId: event.slot_instance_id,
      opportunityId: event.opportunity_id,
      sdkInitId: event.sdk_init_id,
    },
  };
  function journal(id: string, payload: any) {
    const signed = {
      eventId: id,
      partition: "ads:test",
      previousHash: null,
      payload,
      keyId: "test",
    };
    return {
      event_id: id,
      partition: "ads:test",
      previous_hash: null,
      payload,
      key_id: "test",
      record_hash: evidenceSignature(signed),
    };
  }
  const eventJournal = journal(eventId, payload),
    issued = journal("request", {
      serveId: "serve",
      serverServedAt: serve.served_at.toISOString(),
      houseRewardContext: context,
    });
  if (patch.badIssue) issued.record_hash = "forged";
  if (patch.badEvent) eventJournal.record_hash = "forged";
  const supply = {
    user_id: "owner",
    promoter_active: true,
    user_active: true,
    website_active: true,
    slot_active: true,
    lifecycle_status: "active",
    verification_status: "verified",
    verification_expires_at: new Date("2099-01-01"),
    policy_status: "approved",
    ...patch.supply,
  };
  const responses = [
    [event],
    [serve],
    [eventJournal],
    [],
    [supply],
    patch.control ? [{ id: "control" }] : [],
    [{ id: "policy", terms, approved_at: new Date("2026-10-31") }],
    [issued],
  ];
  const tx = {
    execute: jest.fn(async () => ({ rows: responses.shift() ?? [] })),
  };
  return { service: new CfigService({}), tx };
}
describe("PLAN-0070 original approved status and signed evidence", () => {
  it.each([
    { context: { websitePolicy: "testing" } },
    { context: { websitePolicy: "pending_approval" } },
    { context: { programAuthorized: false } },
    { context: { policyDigest: "changed" } },
    { context: { ownershipExpiresAt: "2026-10-01" } },
    { supply: { policy_status: "testing" } },
    { supply: { website_suspended: true } },
    { supply: { promoter_suspended: true } },
    { serve: { inventory_class: "shadow" } },
    { event: { slot_instance_id: null } },
    { event: { duration_ms: 0 } },
    { event: { assessment_status: "invalidated" } },
    { badIssue: true },
    { badEvent: true },
    { control: true },
  ])(
    "rejects ineligible original/current state or tampered evidence %j",
    async (patch) => {
      const h = fixture(patch);
      await expect((h.service as any).proof(h.tx, eventId)).rejects.toThrow();
    },
  );
  it("current approval does not retroactively reward a TESTING serve", async () => {
    const h = fixture({ context: { websitePolicy: "testing" } });
    await expect((h.service as any).proof(h.tx, eventId)).rejects.toThrow(
      "serve time",
    );
  });
  it("valid bound House view and click stay financially nonpayable while separately reward-reviewable", async () => {
    for (const patch of [{}, { click: true }]) {
      const h = fixture(patch),
        r = await (h.service as any).proof(h.tx, eventId);
      expect(r.event.financial_eligibility).toBe("invalid");
      expect(r.policy.id).toBe("policy");
    }
  });
});
