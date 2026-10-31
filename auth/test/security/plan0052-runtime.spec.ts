jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('http', () => ({ createServer: jest.fn(() => ({ listen: jest.fn(), on: jest.fn() })) }));
jest.mock('@crimfig/shared', () => ({
  FINANCIAL_SECURITY_POLICY: jest.requireActual('../../../shared/src/financial-security/policy.config').FINANCIAL_SECURITY_POLICY,
  PostgresFinancialAuthority: class {}, IndependentWithdrawalExecutor: class {}, IsolatedPaystackAdapter: class {}, FinancialPrivateApi: class {},
  ProviderApprovalGate: class {},
}));
import { Pool } from 'pg';
import { createServer } from 'http';
import { generateKeyPairSync } from 'crypto';
import { startFinancialAuthority } from '../../../api/billing-api/src/financial-security-main';

describe('PLAN-0052 isolated runtime composition (no listener or database started)', () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const names = ['FINANCIAL_AUTHORITY_DATABASE_URL','FINANCIAL_READ_MODEL_DATABASE_URL','FINANCIAL_AUTH_PUBLIC_KEYS',
    'FINANCIAL_WORKLOAD_PUBLIC_KEYS','FINANCIAL_PROVIDER_ENVIRONMENT','FINANCIAL_PAYSTACK_SECRET_KEY','FINANCIAL_AUTHORITY_SIGNING_KEY_ID','FINANCIAL_AUTHORITY_SIGNING_PRIVATE_KEY'];
  let prior: Record<string, string | undefined>;
  beforeEach(() => {
    prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
    Object.assign(process.env, { FINANCIAL_AUTHORITY_DATABASE_URL: 'postgres://authority:fixture@localhost/authority', FINANCIAL_READ_MODEL_DATABASE_URL: 'postgres://reader:fixture@localhost/billing',
      FINANCIAL_AUTH_PUBLIC_KEYS: JSON.stringify({ auth: publicKey }), FINANCIAL_WORKLOAD_PUBLIC_KEYS: JSON.stringify({ billing: { publicKey, role: 'billing' } }), FINANCIAL_PROVIDER_ENVIRONMENT: 'test', FINANCIAL_AUTHORITY_SIGNING_KEY_ID: 'authority', FINANCIAL_AUTHORITY_SIGNING_PRIVATE_KEY: privateKey });
    delete process.env.FINANCIAL_PAYSTACK_SECRET_KEY; jest.clearAllMocks();
  });
  afterEach(() => { for (const n of names) if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; });
  function pools(sourceWrite = false, superuser = false, evidenceWrite = false) {
    const authority = { query: jest.fn().mockResolvedValueOnce({ rows: [{ rolsuper: superuser, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }] })
      .mockResolvedValueOnce({ rows: [{ owns_schema: false, owns_tables: false, can_rewrite_evidence: evidenceWrite }] }), end: jest.fn().mockResolvedValue(undefined) };
    const source = { query: jest.fn().mockResolvedValue({ rows: [{ can_write: sourceWrite }] }), end: jest.fn().mockResolvedValue(undefined) };
    (Pool as unknown as jest.Mock).mockImplementationOnce(() => authority).mockImplementationOnce(() => source);
    return { authority, source };
  }
  test('shared authority/source database is rejected before connecting', async () => {
    process.env.FINANCIAL_AUTHORITY_DATABASE_URL = 'postgres://authority:fixture@localhost/billing';
    await expect(startFinancialAuthority()).rejects.toThrow('Separate'); expect(Pool).not.toHaveBeenCalled(); expect(createServer).not.toHaveBeenCalled();
  });
  test.each(['source-write','superuser','evidence-write'])('unsafe %s privileges cannot start a listener', async kind => {
    const s = pools(kind === 'source-write', kind === 'superuser', kind === 'evidence-write');
    await expect(startFinancialAuthority()).rejects.toThrow(); expect(createServer).not.toHaveBeenCalled();
    expect(s.authority.end).toHaveBeenCalledTimes(1); expect(s.source.end).toHaveBeenCalledTimes(1);
  });
  test('separate restricted pools compose the dormant runtime without any provider call', async () => {
    pools(); const server = await startFinancialAuthority(); expect(server.listen).toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledTimes(1);
  });
});
