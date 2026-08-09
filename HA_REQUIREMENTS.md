# Crimfig Platform — High Availability & Service Continuity Requirements
> **Version:** 1.0 · **Created:** 2026-08-08 · **Status:** MANDATORY
>
> ⚠️ These are **non-negotiable engineering standards** for every backend service in the Crimfig ecosystem.
> Every new service author MUST read this document before writing code.
> Every code reviewer MUST verify these requirements are met before approving a PR.

---

## Why This Document Exists

During initial development of the Auth API, a critical HA bug was caught early:
the OAuth authorization code store was implemented using an **in-memory JavaScript Map**.
This works fine for a single instance but silently breaks when the service scales to 2+ replicas —
auth codes generated on Replica A are invisible to Replica B.

This document captures all requirements to prevent this class of problem across every service.

---

## 1. The Golden Rule: No Local State

> **Any state that must survive a process restart or be visible across multiple instances MUST live in an external store.**

| ❌ Never store in process memory | ✅ Store here instead |
|---|---|
| Auth codes, session data | Redis (with TTL) |
| Rate limit counters | Redis |
| User sessions / login state | Redis |
| Pub/sub messages between services | NATS JetStream |
| Uploaded files / media blobs | S3-compatible object storage |
| Any data that must be queried | PostgreSQL |
| Temporary job queues | Redis (BullMQ) or NATS |

The only things allowed in process memory are:
- Configuration values loaded at startup (`config.ts`)
- Compiled code and module references
- Caches with a defined max-age that can be safely invalidated on restart

---

## 2. Every Service Must Implement: Dual Health Probes

Every NestJS service must expose **two** health endpoints. These are not optional.

### Liveness Probe — `GET /api/health`
- **Purpose:** "Is the process alive?" Railway restarts the container if this fails.
- **Must respond in:** < 500ms
- **Must NOT check:** database, Redis, or any external dependency
- **Returns:** `{ status: 'ok', service: 'crimfig-xxx-api', timestamp: '...' }`

### Readiness Probe — `GET /api/health/ready`
- **Purpose:** "Is this instance ready to accept traffic?" The load balancer stops routing to this instance if it returns non-2xx.
- **Must check:** Every external dependency the service requires (DB, Redis, NATS, etc.)
- **Returns 200** when all dependencies are healthy
- **Returns 503** when any dependency is unavailable

```typescript
// Pattern to follow — from backend/auth/src/modules/health/health.controller.ts
@Get('ready')
async readiness() {
  const [dbOk, redisOk] = await Promise.allSettled([
    this.checkDb(),
    this.checkRedis(),
  ]);
  const ready = dbOk.status === 'fulfilled' && dbOk.value
             && redisOk.status === 'fulfilled' && redisOk.value;

  // HTTP 503 returned automatically when ready === false
  return { status: ready ? 'ready' : 'not_ready', checks: { ... } };
}
```

> **Railway Setup:** Configure the Railway service health check to `GET /api/health`
> (liveness) and `GET /api/health/ready` (readiness). Set a readiness timeout of 30s.

---

## 3. Every Service Must Implement: Graceful Shutdown

All NestJS services must call `enableShutdownHooks()` in `main.ts`.

```typescript
// main.ts — REQUIRED in every service
app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
```

**Why:** When Railway does a rolling deploy, it sends `SIGTERM` to the old instance.
Without shutdown hooks, the process exits immediately — mid-request connections are dropped,
database transactions are aborted, Redis connections leak.

**With shutdown hooks:**
1. Railway sends `SIGTERM`
2. NestJS stops accepting new connections
3. In-flight requests complete (up to 30s)
4. `OnModuleDestroy` hooks fire — Redis clients disconnect cleanly, DB pool drains
5. Process exits with code 0 — Railway marks the instance as cleanly replaced

### Every Resource That Opens a Connection Must Implement `OnModuleDestroy`

```typescript
// Example: any service that opens a Redis connection
@Injectable()
export class MyService implements OnModuleDestroy {
  private redis: RedisClientType;

  async onModuleDestroy() {
    await this.redis.quit(); // ← REQUIRED
  }
}
```

---

## 4. Stateless Services — Architecture Requirement

Every Crimfig microservice MUST be stateless. This means:

- **No sticky sessions.** The load balancer must be able to route any request to any replica.
- **JWT is stateless by design** — access tokens are verified via signature, no DB lookup needed.
- **Refresh tokens are hashed and stored in PostgreSQL** — any replica can validate them.
- **Rate limiting state lives in Redis** — consistent across all replicas.
- **Auth codes live in Redis** — atomic operations ensure single-use even across replicas.

---

## 5. Redis Usage Standards

### Atomic Operations for Shared State
When multiple replicas can read and write the same key, use atomic Redis commands.

```typescript
// ✅ CORRECT — Atomic: GET + DEL in a single pipeline. Thread-safe.
const [value] = await redis.multi().get(key).del(key).exec();

// ❌ WRONG — Race condition: two replicas could both GET before either DELs
const value = await redis.get(key);
await redis.del(key);
```

### Always Set a TTL
Every key written to Redis MUST have a TTL set at write time.
**Never write a Redis key without expiry** — it will leak memory indefinitely.

```typescript
// ✅ TTL enforced by Redis — no cron, no cleanup needed
await redis.set(key, value, { EX: 300 }); // expires in 300 seconds

// ❌ No TTL — memory leak
await redis.set(key, value);
```

### Key Naming Convention
All Redis keys must use a namespaced prefix to prevent collisions between services:

```
oauth:code:<uuid>           — auth codes (backend/auth)
session:<userId>            — user sessions (backend/auth)
rate:<ip>:<endpoint>        — rate limit counters (all services)
chat:room:<roomId>:presence — chat presence (backend/api/chat-api)
```

---

## 6. Database Connection Pool Standards

Every service that connects to PostgreSQL must configure its connection pool appropriately.

```typescript
const pool = new Pool({
  max: 20,                        // max concurrent connections per replica
  idleTimeoutMillis: 30_000,      // release idle connections after 30s
  connectionTimeoutMillis: 5_000, // fail fast if DB unreachable
  ssl: config.DB.SSL ? { rejectUnauthorized: true } : false,
});
```

> **Railway PostgreSQL Note:** Railway's managed PostgreSQL has a default connection limit of 100.
> With 5 services × 3 replicas × 20 connections = 300 potential connections.
> Use **PgBouncer** (connection pooler) in front of PostgreSQL when scaling beyond
> 2 replicas per service, or lower `max` per pool accordingly.

---

## 7. NATS JetStream — Inter-Service Event Bus

For internal service-to-service communication, use **NATS JetStream**, not HTTP.

```
DO NOT call:   await fetch('http://audit-api/log')   ← tight coupling, sync failure
DO this:       nats.publish('audit.log', payload)    ← fire and forget, async
```

### Why NATS for Internal Comms
- **No circular dependency** — services don't need to know each other's URLs.
- **Durability** — JetStream persists messages if the consumer is temporarily down.
- **Replay** — missed events can be replayed from the stream after a service recovers.
- **Fan-out** — one event can be consumed by multiple services simultaneously.

### Subject Naming Convention
```
crimfig.<domain>.<entity>.<event>

Examples:
  crimfig.auth.user.created
  crimfig.auth.user.login_failed
  crimfig.auth.org.member_invited
  crimfig.ads.campaign.created
  crimfig.chat.message.sent
```

---

## 8. Deployment Topology (Per Service)

```
Internet
    │
    ▼
[Railway Load Balancer]
    │
    ├── [auth-api replica 1]  ──┐
    ├── [auth-api replica 2]  ──┼── [Redis] ── shared ephemeral state
    └── [auth-api replica 3]  ──┘      │
                                  [PostgreSQL] ── persistent data
                                  [NATS JetStream] ── events
                                       │
                                  [audit-api] ── consumes & writes audit_logs
```

### Minimum Replica Counts (Recommended)

| Service | Staging | Production |
|---|---|---|
| `auth` | 1 | **3+** (HA critical — SSO is a single point of failure) |
| `audit` | 1 | 2 |
| `ads-api` | 1 | 2+ |
| `chat-api` | 1 | **3+** (WebSocket scale) |
| `notifications-api` | 1 | 2 |

---

## 9. Zero-Downtime Deployment Checklist

Before merging and deploying any service update, the PR author verifies:

- [ ] New code handles both old and new DB schema (migrations are additive only)
- [ ] API version bumped if request/response shape changed (`/v1/` → `/v2/`)
- [ ] `/api/health` returns `200` after deploy
- [ ] `/api/health/ready` verified locally with DB + Redis connected
- [ ] `OnModuleDestroy` implemented for every new connection resource
- [ ] No new in-memory state introduced that must survive a restart
- [ ] All new Redis keys use proper namespace prefix and TTL
- [ ] No `DROP COLUMN` in migrations on live data — use `deleted_at` soft delete first

---

## 10. Environment Variables — Required in Every Service

Every NestJS service `.env.example` MUST include these at minimum:

```bash
NODE_ENV=                   # development | staging | production
PORT=                       # HTTP port

# PostgreSQL
DB_HOST=
DB_PORT=5432
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_SSL=false                # true in production (Railway managed DB)

# Redis (required — every service uses it for rate limiting at minimum)
REDIS_URL=                  # redis://localhost:6379 (dev) | rediss://... (prod, TLS)
```

---

## 11. Quick Reference: Anti-Patterns Banned in Crimfig

| ❌ Anti-Pattern | Why Banned | ✅ Use Instead |
|---|---|---|
| `new Map()` for shared state | Breaks with 2+ replicas | Redis |
| `setInterval()` for cleanup | Dies on restart, duplicates across replicas | Redis TTL or BullMQ |
| `setTimeout()` for retry | Non-deterministic, lost on restart | NATS retry policy |
| `process.env.*` in services | Bypasses config validation | `config.*` from `config.ts` |
| HTTP calls between services | Tight coupling, sync failure propagation | NATS JetStream publish |
| `DROP COLUMN` in live migrations | Data loss on rollback | Soft delete first, drop later |
| Raw tokens/secrets stored in DB | Security breach surface | SHA-256 hash before storing |
| Redis keys without TTL | Memory leak in production | Always set `EX` or `PX` |
| Non-atomic Redis read-then-write | Race condition across replicas | `multi().get().del().exec()` |
