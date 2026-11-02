import { AsyncLocalStorage } from "async_hooks";

const secretKey =
  /password|passcode|otp|secret|credential|token|authorization|cookie|api.?key|private.?key|signature|cvv|cvc|card|^pin$|^pan$|connection|database.?url|raw.?body/i;
export function diagnosticPolicy(
  env: Record<string, string | undefined> = process.env,
) {
  const retentionDays = Number(
      env.ERROR_MONITOR_DIAGNOSTICS_RETENTION_DAYS || 14,
    ),
    maxBytes = Number(env.ERROR_MONITOR_DIAGNOSTICS_MAX_BYTES || 131072);
  const perMinute = Number(env.ERROR_MONITOR_DIAGNOSTICS_PER_MINUTE || 100);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 30 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 32768 ||
    maxBytes > 131072
  )
    throw Error("Invalid diagnostic retention or byte limit");
  if (
    env.ERROR_MONITOR_DIAGNOSTICS_ENABLED &&
    !["true", "false"].includes(env.ERROR_MONITOR_DIAGNOSTICS_ENABLED)
  )
    throw Error("Invalid diagnostic enable flag");
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 1000)
    throw Error("Invalid diagnostic rate limit");
  return {
    enabled: env.ERROR_MONITOR_DIAGNOSTICS_ENABLED !== "false",
    retentionDays,
    maxBytes,
    perMinute,
  };
}
const rates = new Map<string, { minute: number; count: number }>();
export function reserveDiagnosticCapture(service: string, now = Date.now()) {
  const minute = Math.floor(now / 60000),
    current = rates.get(service);
  const bucket = current?.minute === minute ? current : { minute, count: 0 };
  rates.set(service, bucket);
  return ++bucket.count <= diagnosticPolicy().perMinute;
}
const scopes = new AsyncLocalStorage<{
  logs: unknown[];
  bytes: number;
  dropped: number;
}>();
export function diagnosticText(value: string, max = 4096): string {
  const clipped = value.length > 65536;
  value = value.slice(0, 65536);
  const cleaned = value
    .replace(
      /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/(?:Bearer|Basic)\s+[^\s,"']+/gi, "[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(
      /\b(?:sk|pk|rk)_(?:live|test)_[\w-]+|xkeysib-[\w-]+/gi,
      "[REDACTED]",
    )
    .replace(
      /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      "[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|key|secret|signature|password|code|api_key)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b([\w.%+-])[\w.%+-]*@([\w.-]+\.[A-Za-z]{2,})\b/g, "$1***@$2")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED]")
    .replace(/([A-Za-z]:[\\/]Users[\\/]|\/home\/)[^\\/\s]+/g, "$1[USER]")
    .replace(
      /(["']?(?:password|secret|api[_-]?key|token|signature)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
      "$1[REDACTED]",
    );
  return cleaned.length > max || clipped
    ? cleaned.slice(0, Math.max(0, max - 20)) + " [TRUNCATED]"
    : cleaned;
}
export function sanitizeDiagnosticValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget = { nodes: 0 },
): any {
  if (++budget.nodes > 1000) return "[NODE LIMIT]";
  if (depth > 8) return "[DEPTH LIMIT]";
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return diagnosticText(value);
  if (typeof value !== "object") return "[UNAVAILABLE]";
  if (seen.has(value)) return "[CYCLE]";
  seen.add(value);
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((v) => sanitizeDiagnosticValue(v, depth + 1, seen, budget));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 100)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    const safeKey = diagnosticText(key, 128);
    let v: unknown;
    try {
      v = (value as any)[key];
    } catch {
      v = "[UNAVAILABLE]";
    }
    out[safeKey] =
      secretKey.test(key) ||
      /^(?:ip|clientIp|actorIp|remoteAddress|fullName|firstName|lastName|address)$/i.test(
        key,
      ) ||
      (/code/i.test(key) && /^\d{4,8}$/.test(String(v)))
        ? "[REDACTED]"
        : /phone|account[_-]?(?:number|no|num)|iban/i.test(key)
          ? `***${String(v).replace(/\D/g, "").slice(-4)}`
          : key === "stack" && typeof v === "string"
            ? diagnosticText(v, 16384)
            : sanitizeDiagnosticValue(v, depth + 1, seen, budget);
  }
  return out;
}
function bounded(value: unknown, max = 16384) {
  try {
    const safe = sanitizeDiagnosticValue(value);
    const text = JSON.stringify(safe);
    return Buffer.byteLength(text || "") > max
      ? {
          status: "truncated",
          preview: diagnosticText(text, max / 2),
          limitBytes: max,
        }
      : safe;
  } catch {
    return { status: "unavailable", reason: "Unsupported value" };
  }
}
export function sanitizedDiagnostics(input: unknown): any {
  const max = diagnosticPolicy().maxBytes;
  let safe: any;
  try {
    safe = sanitizeDiagnosticValue(input);
  } catch {
    return { status: "unavailable", reason: "Unsupported diagnostic envelope" };
  }
  if (!safe || typeof safe !== "object" || Array.isArray(safe))
    return { status: "unavailable" };
  if (safe.request && typeof safe.request === "object")
    safe.request.body = bounded(safe.request.body);
  if (safe.response && typeof safe.response === "object")
    safe.response.body = bounded(safe.response.body);
  if (Array.isArray(safe.logs)) {
    let bytes = 0;
    safe.logs = safe.logs.slice(0, 100).filter((entry: any) => {
      bytes += Buffer.byteLength(JSON.stringify(entry));
      return bytes <= 32768;
    });
  }
  if (Buffer.byteLength(JSON.stringify(safe)) > max) {
    return {
      version: 1,
      status: "truncated",
      reason: "Envelope byte limit",
      limitBytes: max,
      exception: Array.isArray(safe.exception)
        ? safe.exception.slice(0, 1)
        : null,
      request: { status: "omitted", reason: "Envelope byte limit" },
      response: { status: "omitted", reason: "Envelope byte limit" },
      logs: [],
    };
  }
  return safe;
}
export function diagnosticScope(next: () => void, req?: any) {
  const scope = { logs: [], bytes: 0, dropped: 0 };
  if (req) req.__monitorLogScope = scope;
  scopes.run(scope, next);
}
export function appendDiagnosticLog(value: unknown) {
  const scope = scopes.getStore();
  if (!scope) return;
  const entry = bounded(value, 4096),
    bytes = Buffer.byteLength(JSON.stringify(entry));
  if (scope.logs.length >= 100 || scope.bytes + bytes > 32768) {
    scope.dropped++;
    return;
  }
  scope.logs.push(entry);
  scope.bytes += bytes;
}
export function captureDiagnostics(req: any, res: any, error?: unknown) {
  const scope = req.__monitorLogScope || scopes.getStore();
  const e = error as any;
  const causes: unknown[] = [];
  let current = e;
  const seen = new Set();
  for (let i = 0; current && i < 5 && !seen.has(current); i++) {
    seen.add(current);
    causes.push({
      name: diagnosticText(String(current.name || "Error"), 100),
      message: diagnosticText(String(current.message || "Unavailable")),
      stack: diagnosticText(
        String(current.stack || "Stack unavailable")
          .split("\n")
          .slice(0, 65)
          .join("\n"),
        16384,
      ),
      code: diagnosticText(String(current.code || ""), 100),
    });
    current = current.cause;
  }
  const headers: Record<string, unknown> = {};
  for (const key of [
    "content-type",
    "content-length",
    "origin",
    "x-request-id",
    "x-correlation-id",
  ])
    if (req.headers?.[key]) headers[key] = req.headers[key];
  const bodyType = String(req.headers?.["content-type"] || "");
  return sanitizedDiagnostics({
    version: 1,
    capturedAt: new Date().toISOString(),
    durationMs: Math.max(
      0,
      Date.now() - (req.__monitorStartedAt || Date.now()),
    ),
    exception: causes.length ? causes : null,
    request: {
      method: req.method,
      path: diagnosticText(req.route?.path || req.path || "unresolved"),
      headers: bounded(headers),
      params: bounded(req.params),
      query: bounded(req.query),
      body:
        /multipart|octet-stream/i.test(bodyType) ||
        /\/(?:auth|login|password|otp|mfa|webhooks?)(?:\/|$)/i.test(
          req.route?.path || req.path || req.url || "",
        )
          ? {
              status: "omitted",
              reason: "binary, multipart or sensitive identity/webhook route",
            }
          : bounded(req.body),
    },
    response: {
      status: res.statusCode,
      headers: { "content-type": res.getHeader?.("content-type") },
      body: req.__monitorResponseBody ?? {
        status: "unavailable",
        reason: "No parsed final response captured",
      },
    },
    logs: scope?.logs || [],
    droppedLogEntries: scope?.dropped || 0,
    logCoverage:
      "Bounded request-scoped CrimfigLogger entries; other infrastructure logs not captured",
  });
}
/** Observe framework send/json without reading or buffering streams. */
export function observeDiagnosticResponse(req: any, res: any) {
  req.__monitorStartedAt = Date.now();
  for (const method of ["json", "send"]) {
    const original = res[method];
    if (typeof original !== "function") continue;
    res[method] = function (...args: any[]) {
      const [body] = args;
      try {
        if (!Buffer.isBuffer(body) && !req.__monitorResponseBody) {
          let parsed = body;
          if (typeof body === "string") {
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = body;
            }
          }
          req.__monitorResponseBody = bounded(parsed);
        }
      } catch {
        req.__monitorResponseBody = {
          status: "unavailable",
          reason: "Capture failed",
        };
      }
      return original.apply(this, args);
    };
  }
}
