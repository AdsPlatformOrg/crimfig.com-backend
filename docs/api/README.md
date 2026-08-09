# docs/api — CrimFig OpenAPI Contract

This directory is the **cross-repo type contract** between the frontend and backend.

## How It Works

1. Backend NestJS services auto-generate Swagger JSON on build.
2. The generated spec is committed here.
3. Frontend CI downloads the latest spec and runs `pnpm openapi-generate` to produce typed API clients.

## Files

| File | Service | Status |
|---|---|---|
| `auth-api.json` | `backend/auth` | 🔲 Pending (Phase 1) |
| `ads-api.json` | `backend/api/ads-api` | 🔲 Pending (Phase 2) |
| `chat-api.json` | `backend/api/chat-api` | 🔲 Pending (Phase 2) |
| `reels-api.json` | `backend/api/reels-api` | 🔲 Pending (Phase 3) |
| `stream-api.json` | `backend/api/stream-api` | 🔲 Pending (Phase 3) |

## Generation Command

```bash
# From each backend service directory
pnpm build           # builds + outputs swagger.json to ../../docs/api/<service>-api.json
```

## Frontend Client Generation

```bash
# From crimfig-frontend root (when split to separate repo)
pnpm openapi-generate --input docs/api/auth-api.json --output web/auth/src/api
```
