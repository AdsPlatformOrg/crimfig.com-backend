jest.mock("../../src/config/config", () => ({
  config: {
    IS_PRODUCTION: false,
    APP: { AUTH_WEB_URL: "https://auth.example" },
  },
}));
jest.mock("../../src/modules/database/database.module", () => ({
  DATABASE_TOKEN: "DATABASE",
}));
import { EventEmitter } from "events";
import {
  captureDiagnostics,
  reserveDiagnosticCapture,
  diagnosticPolicy,
  diagnosticScope,
  appendDiagnosticLog,
  sanitizedDiagnostics,
} from "../../../shared/src/monitoring/request-diagnostics";
import { errorMonitorBoundary } from "../../../shared/src/monitoring/error-monitor.boundary";
import { redactAndSanitizeErrorEvent } from "../../../shared/src/monitoring/error-monitor.contract";
import { HttpErrorMonitorSink } from "../../../shared/src/monitoring/error-monitor.http-sink";
import {
  diagnosticQuery,
  ErrorDiagnosticsController,
} from "../../src/modules/error-monitor/error-diagnostics.controller";
import { ErrorDiagnosticsRetentionWorker } from "../../src/modules/error-monitor/error-diagnostics-retention.worker";
import { errorMonitorOccurrences } from "@crimfig/database/schema";
import { ErrorMonitorService } from "../../src/modules/error-monitor/error-monitor.service";
describe("PLAN0064 masked diagnostics", () => {
  it.each([
    { ERROR_MONITOR_DIAGNOSTICS_RETENTION_DAYS: "31" },
    { ERROR_MONITOR_DIAGNOSTICS_MAX_BYTES: "999999" },
    { ERROR_MONITOR_DIAGNOSTICS_ENABLED: "yes" },
  ])("rejects invalid policy %j", (env) =>
    expect(() => diagnosticPolicy(env)).toThrow(),
  );
  it("redacts nested credentials and masks approved identifiers before serialization", () => {
    const input: any = {
      authorization: "Bearer sensitive",
      password: "password-value",
      nested: [
        {
          api_key: "api-key-value",
          email: "jed@example.com",
          phone: "+2348012345678",
        },
      ],
      message:
        "Bearer secretBearer password=secretValue postgres://user:pw@host/db",
    };
    input.cycle = input;
    const output = JSON.stringify(sanitizedDiagnostics(input));
    for (const value of [
      "password-value",
      "api-key-value",
      "jed@example.com",
      "secretBearer",
      "secretValue",
      "user:pw",
    ])
      expect(output).not.toContain(value);
    expect(output).toContain("j***@example.com");
    expect(output).toContain("5678");
    expect(output).toContain("[CYCLE]");
  });
  it("does not trust browser-submitted server diagnostics", () => {
    const event = redactAndSanitizeErrorEvent({
      service: "ads-web",
      source: "browser",
      statusCode: 500,
      httpMethod: "GET",
      route: "/test",
      diagnostics: { stack: "forged" },
    });
    expect(event.diagnostics).toBeNull();
  });
  it.each([
    { limit: "101" },
    { offset: "-1" },
    { groupId: "invalid" },
    { service: "ads-api;drop" },
  ])("rejects invalid search without querying", (q) =>
    expect(() => diagnosticQuery(q as any)).toThrow(),
  );
  it("does not reveal cross-scope or missing occurrences and never writes an access success", async () => {
    const db = { execute: jest.fn(async () => ({ rows: [] })) };
    await expect(
      new ErrorDiagnosticsController(db).read(
        "id",
        { environment: "production" },
        { user: { sub: "staff" } },
      ),
    ).rejects.toThrow("Occurrence not found");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
  it("makes expired diagnostics unavailable even before cleanup", async () => {
    const db = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "id",
              expires: new Date(0),
              diagnostics: { secret: "must-not-appear" },
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const result = await new ErrorDiagnosticsController(db).read(
      "id",
      {},
      { user: { sub: "staff" } },
    );
    expect(result.data).toMatchObject({
      availability: "expired",
      diagnostics: null,
    });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
  it("captures final JSON and original stack once after error formatting", async () => {
    const req: any = {
      method: "POST",
      url: "/test",
      headers: { "content-type": "application/json" },
      body: { password: "do-not-store", safe: 42 },
      query: { token: "do-not-store" },
    };
    const res: any = new EventEmitter();
    res.statusCode = 500;
    res.setHeader = jest.fn();
    res.getHeader = () => "application/json";
    res.json = jest.fn();
    res.send = jest.fn();
    const sink = {
      recordEvent: jest.fn(async (_event: any) => ({ recorded: true })),
    };
    const previous = process.env.ERROR_MONITOR_CAPTURE_ENABLED;
    process.env.ERROR_MONITOR_CAPTURE_ENABLED = "true";
    try {
      errorMonitorBoundary("ads-api", sink)(req, res, () => {
        appendDiagnosticLog({
          message: "Before failure",
          apiKey: "do-not-store",
        });
        req.__monitorException = captureDiagnostics(
          req,
          res,
          new Error("Root problem"),
        ).exception;
        res.json({ code: "INTERNAL_ERROR", password: "do-not-store" });
      });
      res.emit("finish");
      await Promise.resolve();
      expect(sink.recordEvent).toHaveBeenCalledTimes(1);
      const event = sink.recordEvent.mock.calls[0][0] as any;
      expect(event.diagnostics.exception[0].stack).toContain("Root problem");
      expect(event.diagnostics.response.body.code).toBe("INTERNAL_ERROR");
      expect(event.diagnostics.logs).toHaveLength(1);
      expect(JSON.stringify(event)).not.toContain("do-not-store");
    } finally {
      if (previous === undefined)
        delete process.env.ERROR_MONITOR_CAPTURE_ENABLED;
      else process.env.ERROR_MONITOR_CAPTURE_ENABLED = previous;
    }
  });
  it("keeps concurrent scoped buffers isolated and records dropped logs", () => {
    diagnosticScope(() => {
      for (let i = 0; i < 120; i++) appendDiagnosticLog({ message: "first" });
      expect(
        captureDiagnostics({ headers: {} }, { statusCode: 500 }).logs,
      ).toHaveLength(100);
      expect(
        captureDiagnostics({ headers: {} }, { statusCode: 500 })
          .droppedLogEntries,
      ).toBe(20);
    });
    diagnosticScope(() =>
      expect(
        captureDiagnostics({ headers: {} }, { statusCode: 500 }).logs,
      ).toHaveLength(0),
    );
  });
  it("transports the masked envelope and requires confirmed central acceptance", async () => {
    const send = jest.fn(async () => ({
      ok: true,
      json: async () => ({ status: "accepted", data: { recorded: true } }),
    }));
    const event = redactAndSanitizeErrorEvent({
      service: "ads-api",
      httpMethod: "GET",
      route: "/test",
      statusCode: 500,
      diagnostics: { request: { body: { password: "not-transported" } } },
    });
    await new HttpErrorMonitorSink(
      {
        ERROR_MONITOR_INGEST_URL:
          "https://auth.example/api/v1/internal/error-monitor/events",
        ERROR_MONITOR_INTERNAL_KEY: "internal",
      },
      send as any,
    ).recordEvent(event);
    const body = JSON.parse((send.mock.calls[0] as any)[1].body);
    expect(body.diagnostics.request.body.password).toBe("[REDACTED]");
  });
  it("cleans expired payloads independently of notification email", async () => {
    const tx = { execute: jest.fn(async () => ({ rows: [] })) };
    const worker = new ErrorDiagnosticsRetentionWorker({
      transaction: (cb: any) => cb(tx),
    });
    await worker.tick();
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it("reports distinct source rows for staging and production rather than picking one", async () => {
    const rows = [
      {
        environment: "staging",
        service: "ads-api",
        status: "active",
        captureEnabled: true,
        lastEventAt: new Date(),
      },
      {
        environment: "production",
        service: "ads-api",
        status: "active",
        captureEnabled: false,
        lastEventAt: new Date(0),
      },
    ];
    const db = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    };
    const result = await new ErrorMonitorService(
      db as any,
      {} as any,
    ).listSources("all");
    expect(result.filter((r) => r.service === "ads-api")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: "staging",
          captureEnabled: true,
        }),
        expect.objectContaining({
          environment: "production",
          captureEnabled: false,
          status: "stale",
        }),
      ]),
    );
  });
  it("limits detailed captures independently of counted error occurrences", () => {
    for (let i = 0; i < 100; i++)
      expect(reserveDiagnosticCapture("quota-unit", 0)).toBe(true);
    expect(reserveDiagnosticCapture("quota-unit", 0)).toBe(false);
    expect(reserveDiagnosticCapture("quota-unit", 60000)).toBe(true);
  });
  it("retains a diagnostic occurrence beyond the 25 representative group samples", async () => {
    const group = {
      id: "group",
      sampledOccurrenceCount: 25,
      occurrenceCount: 30,
      windowSuppressedCount: 0,
      notificationState: "disabled",
      windowStartedAt: null,
      windowEndsAt: null,
    };
    const writes: any[] = [];
    const query: any = {
      where: () => query,
      for: () => query,
      limit: async () => [group],
    };
    const tx: any = {
      select: () => ({ from: () => query }),
      insert: (table: any) => ({
        values: (value: any) => {
          writes.push({ table, value });
          return {
            onConflictDoUpdate: async () => [],
            onConflictDoNothing: async () => [],
          };
        },
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [group] }) }),
      }),
      execute: async () => ({ rows: [] }),
    };
    const event = redactAndSanitizeErrorEvent(
      {
        service: "ads-api",
        source: "server",
        httpMethod: "GET",
        route: "/test",
        statusCode: 500,
        diagnostics: { version: 1, exception: [{ message: "Failure" }] },
      },
      { ERROR_MONITOR_CAPTURE_ENABLED: "true" },
    );
    await new ErrorMonitorService(
      { transaction: (cb: any) => cb(tx) } as any,
      {} as any,
    ).recordEvent(event, {
      ERROR_MONITOR_CAPTURE_ENABLED: "true",
      ERROR_MONITOR_EMAIL_ENABLED: "false",
    });
    expect(
      writes.find((w) => w.table === errorMonitorOccurrences)?.value,
    ).toMatchObject({ diagnostics: expect.objectContaining({ version: 1 }) });
  });
});
