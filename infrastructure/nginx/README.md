# infrastructure/nginx — Reverse Proxy & Subdomain Routing

Nginx configuration for local development and production subdomain routing.

## Subdomain Routing

| Subdomain | Backend Service | Frontend App |
|---|---|---|
| `auth.crimfig.com` | `backend/auth` (port 4000) | `frontend/web/auth` |
| `ads.crimfig.com` | `backend/api/ads-api` (port 4001) | `frontend/web/ads` |
| `chat.crimfig.com` | `backend/api/chat-api` (port 4002) | `frontend/web/chat` |
| `reels.crimfig.com` | `backend/api/reels-api` (port 4003) | `frontend/web/reels` |
| `stream.crimfig.com` | `backend/api/stream-api` (port 4004) | `frontend/web/stream` |
| `tetrisgame.crimfig.com` | — | `frontend/web/tetris` |

## Files (Populated in Phase 1)

- `nginx.conf` — main config
- `conf.d/auth.conf` — auth subdomain vhost
- `conf.d/ads.conf` — ads subdomain vhost
- `conf.d/chat.conf` — chat subdomain vhost (WebSocket support)
