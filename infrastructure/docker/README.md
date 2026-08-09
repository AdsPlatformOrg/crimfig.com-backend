# infrastructure/docker — Container Definitions

Dockerfiles and Docker Compose configurations for all CrimFig services.

## Files

| File | Purpose |
|---|---|
| `docker-compose.dev.yml` | Local dev: PostgreSQL + Redis only (services run natively) |
| `docker-compose.full.yml` | Full local stack: all services containerized |
| `Dockerfile.auth` | Production image for `backend/auth` |
| `Dockerfile.audit` | Production image for `backend/audit` |
| `Dockerfile.ads-api` | Production image for `backend/api/ads-api` |
| `Dockerfile.chat-api` | Production image for `backend/api/chat-api` |

## Quick Start (Local Dev Infrastructure)

```bash
# Start only the infrastructure (Postgres + Redis) — recommended for dev
docker compose -f infrastructure/docker/docker-compose.dev.yml up -d

# Stop
docker compose -f infrastructure/docker/docker-compose.dev.yml down

# Destroy volumes (reset all data)
docker compose -f infrastructure/docker/docker-compose.dev.yml down -v
```
