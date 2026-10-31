/** Separate process entry point. Never import into Billing AppModule or share its runtime credentials. */
import { createServer } from 'http';
import { createPrivateKey, createPublicKey } from 'crypto';
import { Pool } from 'pg';
import { FinancialPrivateApi, IndependentWithdrawalExecutor, IsolatedPaystackAdapter, PostgresFinancialAuthority, FINANCIAL_SECURITY_POLICY, ProviderApprovalGate } from '@crimfig/shared';
import { PostgresQuoteSource } from './financial-security/quote-source';
import { PaystackProviderBroker } from '@crimfig/shared';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
export async function startFinancialAuthority() {
  const authorityUrl = new URL(required('FINANCIAL_AUTHORITY_DATABASE_URL'));
  const sourceUrl = new URL(required('FINANCIAL_READ_MODEL_DATABASE_URL'));
  if (authorityUrl.host === sourceUrl.host && (authorityUrl.pathname === sourceUrl.pathname || authorityUrl.username === sourceUrl.username)) throw new Error('Separate authority database and runtime identities are required');
  const authorityPool = new Pool({ connectionString: authorityUrl.toString(), max: 5, statement_timeout: 5000, connectionTimeoutMillis: 3000 });
  const sourcePool = new Pool({ connectionString: sourceUrl.toString(), max: 3, statement_timeout: 3000, connectionTimeoutMillis: 3000 });
  try {
    const privilege = await sourcePool.query(`SELECT bool_or(has_table_privilege(current_user,t,'INSERT,UPDATE,DELETE,TRUNCATE')) AS can_write
      FROM unnest(ARRAY['billing_wallets','billing_transactions','billing_provider_events','billing_bank_accounts','billing_withdrawal_requests','users','auth_financial_identities']) t`);
    if (privilege.rows[0]?.can_write !== false) throw new Error('Financial source credentials must be read-only');
    const role = await authorityPool.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if (!role.rows[0] || Object.values(role.rows[0]).some(Boolean)) throw new Error('Privileged authority runtime role rejected');
    const independent = await authorityPool.query(`SELECT
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='financial_authority' AND pg_has_role(current_user,nspowner,'USAGE')) AS owns_schema,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='financial_authority' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_tables,
      has_table_privilege(current_user,'financial_authority.runtime_readiness','INSERT,UPDATE,DELETE,TRUNCATE') OR
      has_table_privilege(current_user,'financial_authority.assessments','INSERT,UPDATE,DELETE,TRUNCATE') OR
      has_table_privilege(current_user,'financial_authority.platform_admins','INSERT,UPDATE,DELETE,TRUNCATE') AS can_rewrite_evidence`);
    if (!independent.rows[0] || Object.values(independent.rows[0]).some(Boolean)) throw new Error('Independent evidence permissions are required');
    const store = new PostgresFinancialAuthority(authorityPool);
    const authKeys = JSON.parse(required('FINANCIAL_AUTH_PUBLIC_KEYS'));
    const workloads = JSON.parse(required('FINANCIAL_WORKLOAD_PUBLIC_KEYS'));
    if (!authKeys || Array.isArray(authKeys) || !Object.keys(authKeys).length
      || Object.values(authKeys).some(value => typeof value !== 'string' || createPublicKey(value).asymmetricKeyType !== 'ed25519')
      || !workloads || Array.isArray(workloads) || !Object.keys(workloads).length
      || Object.values(workloads).some((value: any) => !['billing','auth'].includes(value?.role) || createPublicKey(value.publicKey).asymmetricKeyType !== 'ed25519')
      || createPrivateKey(required('FINANCIAL_AUTHORITY_SIGNING_PRIVATE_KEY')).asymmetricKeyType !== 'ed25519') throw new Error('Valid isolated trust keys are required');
    const environment = required('FINANCIAL_PROVIDER_ENVIRONMENT');
    if (!['test','live'].includes(environment)) throw new Error('Invalid provider environment');
    const secret = process.env.FINANCIAL_PAYSTACK_SECRET_KEY;
    const adapter = secret ? new IsolatedPaystackAdapter(secret, environment as 'test'|'live')
      : { submit: async () => { throw new Error('Isolated provider credentials unavailable'); } };
    const executor = new IndependentWithdrawalExecutor(store, adapter, {
      independentlyVerified: async () => {
        const { rows } = await authorityPool.query(`SELECT ready FROM financial_authority.runtime_readiness
          WHERE id='withdrawal' AND valid_until > clock_timestamp() AND observed_at <= clock_timestamp()
          AND observed_at >= clock_timestamp()-interval '30 seconds' AND policy_version=$1`, [FINANCIAL_SECURITY_POLICY.version]);
        return !!secret && rows[0]?.ready === true;
      },
    }, authKeys);
    const api = new FinancialPrivateApi(store, new PostgresQuoteSource(sourcePool), executor, workloads, authKeys,
      required('FINANCIAL_AUTHORITY_SIGNING_KEY_ID'), required('FINANCIAL_AUTHORITY_SIGNING_PRIVATE_KEY'),secret?new PaystackProviderBroker(secret):undefined);
    const approval = new ProviderApprovalGate(store, authKeys, () => executor.available());
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      const providerApproval = req.url === `/provider/paystack/${environment}/approval`;
      if (req.method !== 'POST' || (!providerApproval && !req.url?.startsWith('/internal/v1/withdrawals/'))) { res.writeHead(404).end('{}'); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 70000) { res.writeHead(413).end('{}'); return; } chunks.push(bytes); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (providerApproval) {
          const accepted = await approval.approve(environment as 'test'|'live', body);
          res.writeHead(accepted ? 200 : 400).end('{}'); return;
        }
        const result = await api.handle(req.url!, body);
        res.writeHead(200).end(JSON.stringify(result));
      } catch { res.writeHead(403).end(JSON.stringify({ error: 'Financial authority request rejected or unavailable' })); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 5000;
    const port = Number(process.env.FINANCIAL_AUTHORITY_PORT || 4101);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid authority port');
    server.listen(port, process.env.FINANCIAL_AUTHORITY_BIND_ADDRESS || '127.0.0.1');
    server.on('close', () => { void authorityPool.end(); void sourcePool.end(); });
    return server;
  } catch (error) { await Promise.allSettled([authorityPool.end(), sourcePool.end()]); throw error; }
}
if (require.main === module) void startFinancialAuthority().catch(() => { console.error('Financial authority startup failed; inspect protected configuration and database grants.'); process.exitCode = 1; });
