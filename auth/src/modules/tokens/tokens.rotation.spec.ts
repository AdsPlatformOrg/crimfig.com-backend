import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TokensService } from './tokens.service';
import * as schema from '@crimfig/database/schema';

jest.mock('../../config/config', () => ({ config: { JWT: {
  ACCESS_SECRET: 'rotation-test-signing-secret', ACCESS_EXPIRES_IN: '2m',
  REFRESH_EXPIRES_DAYS: 30, MFA_CHALLENGE_EXPIRES_IN: '5m',
} } }));

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const family = 'a56813ea-df01-4c41-a058-1a778ef09eda';
const user = { id: 'f7c85e1b-520e-405c-825a-d9c2ff34c401', email: 'person@example.test', status: 'ACTIVE' };

/** In-memory transactional adapter. SQL predicates are compiled using Drizzle;
 * the service's advisory-lock statement controls the concurrent test schedule.
 * This does not replace a staging test against PostgreSQL. */
function database() {
  const dialect = new PgDialect();
  let rows: any[] = [{ id: 'initial', userId: user.id, appId: 'original-app',
    tokenHash: hash('original'), familyId: family, revokedAt: null,
    deviceFingerprint: 'device', expiresAt: new Date(Date.now() + 86_400_000) }];
  let tail = Promise.resolve();
  let failInsert = false;
  let account: any = { ...user };
  const matches = (where: any, row: any) => {
    const query = dialect.sqlToQuery(where);
    for (const key of ['tokenHash', 'familyId', 'id']) {
      const dbKey = key === 'tokenHash' ? 'token_hash' : key === 'familyId' ? 'family_id' : 'id';
      if (query.sql.includes(`"${dbKey}" =`) && row[key] !== query.params[0]) return false;
    }
    return !query.sql.includes('"revoked_at" is null') || row.revokedAt === null;
  };
  const locks: string[] = [];
  const db: any = {
    transaction: async (work: (tx: any) => Promise<any>) => {
      let release: (() => void) | undefined;
      let before: any[] | undefined;
      const tx = {
        execute: async (statement: any) => {
          if (!dialect.sqlToQuery(statement).sql.includes('pg_advisory_xact_lock')) return;
          locks.push(dialect.sqlToQuery(statement).sql);
          const previous = tail;
          tail = new Promise<void>(resolve => { release = resolve; });
          await previous;
          before = structuredClone(rows);
        },
        query: {
          refreshTokens: { findFirst: async ({ where }: any) => structuredClone(rows.find(row => matches(where, row))) },
          users: { findFirst: async () => account },
        },
        update: () => ({ set: (values: any) => ({ where: async (where: any) => {
          for (const row of rows) if (matches(where, row)) Object.assign(row, values);
        } }) }),
        insert: (table: any) => ({ values: async (values: any) => {
          expect(table).toBe(schema.refreshTokens);
          if (failInsert) throw new Error('storage failure');
          rows.push({ id: `row-${rows.length}`, ...values, revokedAt: null });
        } }),
      };
      try { return await work(tx); }
      catch (error) { if (before) rows = before; throw error; }
      finally { release?.(); }
    },
  };
  return {
    db, locks, rows: () => rows,
    failNextInsert: () => { failInsert = true; },
    accountStatus: (status: string) => { account = { ...user, status }; },
  };
}

describe('refresh rotation and revocation', () => {
  it('preserves original family, app and device; returns the actual signed JWT lifetime', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    const result = await service.rotateRefreshToken('original');
    const claims = new JwtService().decode(result.accessToken) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(120);
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(result.expiresIn).toBeLessThanOrEqual(120);
    expect(store.rows()[0].revokedAt).toBeInstanceOf(Date);
    expect(store.rows()[1]).toMatchObject({ familyId: family, appId: 'original-app', deviceFingerprint: 'device' });
    expect(store.rows()[1].tokenHash).toBe(hash(result.refreshToken));
    expect(store.locks[0]).toContain('pg_advisory_xact_lock');
    expect(store.rows()[1]).not.toHaveProperty('refreshToken');
  });

  it('concurrent requests issue one successor and return conflict to the loser without revoking it', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    const outcomes = await Promise.allSettled([service.rotateRefreshToken('original'), service.rotateRefreshToken('original')]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConflictException);
    expect(store.rows().filter(row => row.revokedAt === null)).toHaveLength(1);
    expect(store.rows()).toHaveLength(2);
  });

  it('rolls back consumption when successor storage fails', async () => {
    const store = database();
    store.failNextInsert();
    const service = new TokensService(store.db, new JwtService());
    await expect(service.rotateRefreshToken('original')).rejects.toThrow('storage failure');
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0].revokedAt).toBeNull();
  });

  it('late replay revokes the surviving family and commits before returning 401', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    await service.rotateRefreshToken('original');
    store.rows()[0].revokedAt = new Date(Date.now() - 11_000);
    await expect(service.rotateRefreshToken('original')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.rows().every(row => row.revokedAt !== null)).toBe(true);
  });

  it('expired tokens and suspended users cannot mint successors', async () => {
    for (const scenario of ['expired', 'SUSPENDED', 'DELETED']) {
      const store = database();
      if (scenario === 'expired') store.rows()[0].expiresAt = new Date(Date.now() - 1);
      else store.accountStatus(scenario);
      const service = new TokensService(store.db, new JwtService());
      await expect(service.rotateRefreshToken('original')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(store.rows()).toHaveLength(1);
      expect(store.rows()[0].revokedAt).toBeInstanceOf(Date);
    }
  });

  it('logout of an old token revokes its successor; wrong authenticated user cannot revoke the family', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    const result = await service.rotateRefreshToken('original');
    await expect(service.revokeRefreshToken('original', 'another-user')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.rows()[1].revokedAt).toBeNull();
    await service.revokeRefreshToken('original', user.id);
    expect(store.rows().every(row => row.revokedAt !== null)).toBe(true);
    await expect(service.rotateRefreshToken(result.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('unknown or malformed refresh tokens issue nothing', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    for (const raw of ['', 'unknown', 'x'.repeat(1025)]) {
      await expect(service.rotateRefreshToken(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(store.rows()[0].revokedAt).toBeNull();
    expect(store.rows()).toHaveLength(1);
  });

  it('a racing logout leaves no live refresh descendant', async () => {
    const store = database();
    const service = new TokensService(store.db, new JwtService());
    await Promise.allSettled([
      service.rotateRefreshToken('original'), service.revokeRefreshToken('original', user.id),
    ]);
    expect(store.rows().filter(row => row.revokedAt === null)).toHaveLength(0);
  });
});
