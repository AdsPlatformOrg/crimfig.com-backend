jest.mock('otplib', () => ({ verifySync: jest.fn().mockReturnValue({ valid: true }), generateSecret: jest.fn(), generateURI: jest.fn() }));
jest.mock('../../src/config/config', () => ({ config: { ENCRYPTION: { KEY: '00'.repeat(32) }, FINANCIAL_AUTH: {
  AUTHORITY_PUBLIC_KEYS: '{}', SIGNING_PRIVATE_KEY: undefined, SIGNING_KEY_ID: undefined, EXPLICIT_PLATFORM_GRANTS: '{}' } } }));
jest.mock('@crimfig/shared', () => ({
  ...jest.requireActual('../../../shared/src/financial-security/policy.config'),
  ...jest.requireActual('../../../shared/src/financial-security/proof-issuer'),
  ...jest.requireActual('../../../shared/src/financial-security/challenge-proposal'),
  ...jest.requireActual('../../../shared/src/financial-security/private-transport'),
  CrimfigLogger: class { audit() {} warn() {} },
}));
jest.mock('../../src/modules/email/email.service', () => ({ EmailService: class {} }));
jest.mock('../../src/modules/tokens/tokens.service', () => ({ TokensService: class {} }));
import { createCipheriv, generateKeyPairSync, sign } from 'crypto';
import { FinancialAuthorizationService } from '../../src/modules/financial-authorization/financial-authorization.service';
import { MfaService } from '../../src/modules/mfa/mfa.service';
import { config } from '../../src/config/config';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
import { proposalMessage, ChallengeProposal } from '../../../shared/src/financial-security/challenge-proposal';
import { signPrivateResponse } from '../../../shared/src/financial-security/private-transport';

describe('PLAN-0052 concrete Auth persistence and TOTP', () => {
  const now = 1_800_000_000_000;
  const pair = generateKeyPairSync('ed25519');
  const actor = '11111111-1111-4111-8111-111111111111';
  const p = (): ChallengeProposal => {
    const result: ChallengeProposal = { version: 1, keyId: 'authority', audience: 'financial-auth', challengeId: '22222222-2222-4222-8222-222222222222', actorId: actor, personId: 'person', purpose: 'owner_authorization', issuedAt: now, expiresAt: now + 60000, signature: '',
      binding: { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: actor, ownerPersonId: 'person', destinationKey: 'account', destinationVersion: 'v1', recipientCode: 'RCP_1', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60000 } };
    result.signature = sign(null, proposalMessage(result), pair.privateKey).toString('base64url'); return result;
  };
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(now);
    Object.assign(config.FINANCIAL_AUTH, { AUTHORITY_PUBLIC_KEYS: JSON.stringify({ authority: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
      SIGNING_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), SIGNING_KEY_ID: 'auth' }); });
  afterEach(() => jest.restoreAllMocks());
  function dbWith(reads: unknown[][]) {
    const chain: any = { from: () => chain, where: () => chain, for: () => Promise.resolve(reads.shift() || []),
      then: (resolve: any) => Promise.resolve(reads.shift() || []).then(resolve) };
    const tx: any = { execute: jest.fn().mockResolvedValue(undefined), select: jest.fn(() => chain),
      insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })), update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })) })) };
    const db: any = { transaction: jest.fn(async work => work(tx)) }; return { tx, db };
  }
  test('forged proposal cannot persist a challenge', async () => {
    const s = dbWith([]); const input = p(); input.binding.amountKobo++;
    await expect(new FinancialAuthorizationService(s.db, {} as any).register(actor, input)).rejects.toThrow(); expect(s.db.transaction).not.toHaveBeenCalled();
  });
  test('invalid withdrawal reference cannot make an Auth authority request', async () => {
    const s = dbWith([]), network = jest.spyOn(globalThis, 'fetch');
    await expect(new FinancialAuthorizationService(s.db, {} as any).begin(actor, 'forged')).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
  test('insecure authority origin cannot receive workload credentials', async () => {
    Object.assign(config.FINANCIAL_AUTH, { AUTHORITY_URL: 'http://authority.invalid/' });
    const network = jest.spyOn(globalThis, 'fetch'), s = dbWith([]);
    await expect(new FinancialAuthorizationService(s.db, {} as any).begin(actor, p().binding.reference)).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
  test('Auth fetches an actor-bound signed proposal before registration', async () => {
    const key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    Object.assign(config.FINANCIAL_AUTH, { AUTHORITY_URL: 'https://authority.invalid/', WORKLOAD_PRIVATE_KEY: key, WORKLOAD_KEY_ID: 'auth-client' });
    const s = dbWith([]), service = new FinancialAuthorizationService(s.db, {} as any);
    const register = jest.spyOn(service, 'register').mockResolvedValue({ challengeId: p().challengeId } as any);
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      expect(JSON.parse(request.body)).toEqual({ userId: actor, reference: p().binding.reference });
      return new Response(JSON.stringify(signPrivateResponse(request, p(), 'authority', key, now)));
    });
    await service.begin(actor, p().binding.reference);
    expect(network).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledWith(actor, p());
  });
  test('suspended account cannot persist a signed challenge', async () => {
    const s = dbWith([[], [{ status: 'SUSPENDED', mfaEnabled: true }], [{ active: true, personId: 'person', recoveryClearedAt: new Date(now - 1) }]]);
    await expect(new FinancialAuthorizationService(s.db, {} as any).register(actor, p())).rejects.toThrow(); expect(s.tx.insert).not.toHaveBeenCalled();
  });
  test('missing signing keys cannot consume a TOTP or challenge', async () => {
    Object.assign(config.FINANCIAL_AUTH, { SIGNING_PRIVATE_KEY: undefined }); const s = dbWith([]); const mfa = { consumeFinancialTotp: jest.fn() };
    await expect(new FinancialAuthorizationService(s.db, mfa as any).confirm(actor, p().challengeId, '123456')).rejects.toThrow();
    expect(s.db.transaction).not.toHaveBeenCalled(); expect(mfa.consumeFinancialTotp).not.toHaveBeenCalled();
  });
  test('a rejected code commits the attempt and never stores a proof', async () => {
    const proposal = p();
    const s = dbWith([[{ proposal, attempts: 0, consumedAt: null }], [{ status: 'ACTIVE', mfaEnabled: true }],
      [{ active: true, personId: 'person', recoveryClearedAt: new Date(now - 1) }], [{ count: 0 }]]);
    const mfa = { consumeFinancialTotp: jest.fn().mockResolvedValue(false) };
    await expect(new FinancialAuthorizationService(s.db, mfa as any).confirm(actor, proposal.challengeId, '123456')).rejects.toThrow('rejected');
    expect(s.tx.update).toHaveBeenCalledTimes(1); expect(await s.db.transaction.mock.results[0].value).toBeNull();
  });
  test('missing recovery challenge cannot reveal another actor proof', async () => {
    const s = dbWith([[]]);
    await expect(new FinancialAuthorizationService(s.db, {} as any).read(actor, p().challengeId)).rejects.toThrow();
    expect(s.tx.update).not.toHaveBeenCalled();
  });
  test('lost-response recovery returns the stored proof without another TOTP or write', async () => {
    const proposal = p(), saved = { nonce: 'original-proof' };
    const s = dbWith([[{ proposal, proof: saved, consumedAt: new Date(now) }], [{ status: 'ACTIVE', mfaEnabled: true }],
      [{ active: true, personId: 'person', recoveryClearedAt: new Date(now - 1) }]]);
    const mfa = { consumeFinancialTotp: jest.fn() };
    expect(await new FinancialAuthorizationService(s.db, mfa as any).read(actor, proposal.challengeId)).toMatchObject({ state: 'confirmed', proof: saved });
    expect(mfa.consumeFinancialTotp).not.toHaveBeenCalled(); expect(s.tx.update).not.toHaveBeenCalled();
  });
  test('valid account persists the immutable server proposal', async () => {
    const s = dbWith([[], [{ status: 'ACTIVE', mfaEnabled: true }], [{ active: true, personId: 'person', recoveryClearedAt: new Date(now - 1) }], [{ count: 0 }], [{ count: 0 }]]);
    expect(await new FinancialAuthorizationService(s.db, {} as any).register(actor, p())).toMatchObject({ challengeId: p().challengeId, consumed: false }); expect(s.tx.insert).toHaveBeenCalledTimes(1);
  });
  function totpSetup(replay = false) {
    const secret = 'JBSWY3DPEHPK3PXP';
    const iv = Buffer.alloc(12, 1), cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32), iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    const device = { id: 'device', createdAt: new Date(now - policy.recoveryCooldownMs), secretOrPublicKey: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
    const s = dbWith([[device]]);
    s.tx.insert = jest.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => replay ? [] : [{ deviceId: 'device' }] }) }) }));
    const service = new MfaService({} as any, {} as any, {} as any);
    return { ...s, device, service, code: '123456' };
  }
  test('backup codes and recent MFA devices cannot authorize financial actions', async () => {
    const s = totpSetup(); expect(await s.service.consumeFinancialTotp(s.tx, actor, 'BACKUP01', now)).toBe(false);
    expect(s.tx.select).not.toHaveBeenCalled(); s.device.createdAt = new Date(now);
    expect(await s.service.consumeFinancialTotp(s.tx, actor, s.code, now)).toBe(false); expect(s.tx.insert).not.toHaveBeenCalled();
  });
  test('replayed TOTP cannot update last-used time or authorize twice', async () => {
    const s = totpSetup(true); expect(await s.service.consumeFinancialTotp(s.tx, actor, s.code, now)).toBe(false); expect(s.tx.update).not.toHaveBeenCalled();
  });
  test('invalid TOTP and verifier errors never consume a device step', async () => {
    const s = totpSetup(); require('otplib').verifySync.mockReturnValueOnce({ valid: false });
    expect(await s.service.consumeFinancialTotp(s.tx, actor, s.code, now)).toBe(false); expect(s.tx.insert).not.toHaveBeenCalled();
    const broken = totpSetup(); require('otplib').verifySync.mockImplementationOnce(() => { throw new Error('bad secret'); });
    expect(await broken.service.consumeFinancialTotp(broken.tx, actor, broken.code, now)).toBe(false); expect(broken.tx.insert).not.toHaveBeenCalled();
  });
  test('library-verified mature-device TOTP consumes one time step', async () => {
    const s = totpSetup(); expect(await s.service.consumeFinancialTotp(s.tx, actor, s.code, now)).toBe(true); expect(s.tx.insert).toHaveBeenCalledTimes(1); expect(s.tx.update).toHaveBeenCalledTimes(1);
    expect(require('otplib').verifySync).toHaveBeenCalledWith({ token: '123456', secret: 'JBSWY3DPEHPK3PXP', epoch: now / 1000, epochTolerance: 0, period: 30, digits: 6 });
  });
});
