import { CfigWorker } from "../../../api/ads-api/src/modules/cfig/cfig.worker";
import * as rules from "../../../api/ads-api/src/modules/cfig/cfig-allocation";
const actor = "00000000-0000-4000-8000-000000000001";
describe("PLAN-0070 optional worker", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-10T00:00Z"));
  });
  const before = {
    enabled: process.env.ADS_CFIG_FINALIZER_ENABLED,
    actor: process.env.ADS_CFIG_FINALIZER_ACTOR_ID,
  };
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (before.enabled === undefined)
      delete process.env.ADS_CFIG_FINALIZER_ENABLED;
    else process.env.ADS_CFIG_FINALIZER_ENABLED = before.enabled;
    if (before.actor === undefined)
      delete process.env.ADS_CFIG_FINALIZER_ACTOR_ID;
    else process.env.ADS_CFIG_FINALIZER_ACTOR_ID = before.actor;
  });
  function worker(roles: string[], active = true) {
    const cfig: any = {
        nextDay: jest.fn(async () => "2026-01-01"),
        finalize: jest.fn(async () => ({})),
      },
      db = {
        execute: jest.fn(async () => ({
          rows: [{ status: active ? "ACTIVE" : "SUSPENDED" }],
        })),
      };
    return {
      instance: new CfigWorker(cfig, { rolesFor: () => roles } as any, db),
      cfig,
      db,
    };
  }
  it("does not start or read database while program remains disabled", async () => {
    const h = worker(["super_admin"]);
    h.instance.onModuleInit();
    await h.instance.tick();
    expect(h.db.execute).not.toHaveBeenCalled();
    expect(h.cfig.finalize).not.toHaveBeenCalled();
    h.instance.onModuleDestroy();
  });
  it("rejects missing financial grants/inactive identity without finalizing", async () => {
    jest.spyOn(rules, "houseProgramRequested").mockReturnValue(true);
    process.env.ADS_CFIG_FINALIZER_ENABLED = "true";
    process.env.ADS_CFIG_FINALIZER_ACTOR_ID = actor;
    for (const h of [worker([]), worker(["ads_finance"], false)]) {
      await h.instance.tick();
      expect(h.cfig.finalize).not.toHaveBeenCalled();
    }
  });
  it("configured active financial identity delegates only a closed day to transactional finalizer", async () => {
    jest.spyOn(rules, "houseProgramRequested").mockReturnValue(true);
    process.env.ADS_CFIG_FINALIZER_ENABLED = "true";
    process.env.ADS_CFIG_FINALIZER_ACTOR_ID = actor;
    const h = worker(["ads_finance"]);
    await h.instance.tick();
    expect(h.cfig.finalize).toHaveBeenCalledWith(
      actor,
      "2026-01-01",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });
});
