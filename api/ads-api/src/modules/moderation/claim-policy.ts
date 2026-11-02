import policy from '../../../../../shared/src/config/moderation-policy.json';
export const CLAIM_POLICY=Object.freeze({ttlSeconds:policy.claims.ttlSeconds,maxLifetimeSeconds:policy.claims.maxLifetimeSeconds,renewal:policy.claims.renewal});
export function claimExpiry(now:Date,started:Date){return new Date(Math.min(now.getTime()+CLAIM_POLICY.ttlSeconds*1000,started.getTime()+CLAIM_POLICY.maxLifetimeSeconds*1000));}
export function activeClaim(claim:{expiresAt:Date|string;releasedAt?:Date|string|null}|null|undefined,now:Date){return !!claim&&!claim.releasedAt&&Number.isFinite(new Date(claim.expiresAt).getTime())&&new Date(claim.expiresAt)>now;}
