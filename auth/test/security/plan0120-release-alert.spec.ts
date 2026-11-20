jest.mock('../../src/config/config', () => ({ config: {} }));
import { generateKeyPairSync } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { ReleaseAlertController } from '../../src/modules/health/release-alert.controller';
import { verifyReleaseAlertIdentity } from '../../src/modules/health/release-alert-identity';
import policy from '../../../shared/src/config/release-alerts.json';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { request } from 'node:http';
import { EmailService } from '../../src/modules/email/email.service';

describe('release email workload identity and delivery', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'release-test-key', kty: 'RSA' };
  const jwt = new JwtService();
  const revision = 'a'.repeat(40);
  const payload = {
    repository: policy.repository, repository_owner: policy.repository.split('/')[0],
    workflow_ref: policy.repository + '/.github/workflows/ci.yml@refs/heads/dev',
    ref: 'refs/heads/dev', run_id: '12345', sha: revision,
  };
  function token(patch: Record<string, unknown> = {}, expiresIn = 300) {
    return jwt.sign({ ...payload, ...patch }, {
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      algorithm: 'RS256', keyid: key.kid, issuer: 'https://token.actions.githubusercontent.com',
      audience: 'crimfig-release-alerts', expiresIn,
    });
  }
  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ keys: [key] }));
  });
  afterAll(() => jest.restoreAllMocks());

  it('rejects missing, expired, foreign repository and mismatched run identities before sending', async () => {
    for (const value of ['', token({}, -1), token({ repository: 'other/repository' }), token({ run_id: '999' })]) {
      await expect(verifyReleaseAlertIdentity(value, '12345')).rejects.toMatchObject({ status: 401 });
    }
    await expect(verifyReleaseAlertIdentity(token({ workflow_ref: policy.repository + '/.github/workflows/unapproved.yml@refs/heads/dev' }), '12345'))
      .rejects.toMatchObject({ status: 401 });
  });
  it('requires revision identity and explicit provider acceptance', async () => {
    const mail = { sendErrorAlertEmail: jest.fn().mockResolvedValue({ accepted: false }) };
    const controller = new ReleaseAlertController(mail as any);
    await expect(controller.notify('Bearer ' + token(), { runId: '12345', revision: 'b'.repeat(40), kind: 'test' }))
      .rejects.toMatchObject({ status: 503 });
    expect(mail.sendErrorAlertEmail).not.toHaveBeenCalled();
    await expect(controller.notify('Bearer ' + token(), { runId: '12345', revision, kind: 'test' }))
      .rejects.toMatchObject({ status: 503 });
    mail.sendErrorAlertEmail.mockResolvedValue({ accepted: true, providerMessageId: 'provider-fixture' });
    await expect(controller.notify('Bearer ' + token(), { runId: '12345', revision, kind: 'test' }))
      .resolves.toMatchObject({ accepted: true });
    await expect(controller.notify('Bearer ' + token(), { runId: '12345', revision, kind: 'test' }))
      .resolves.toEqual({ accepted: true, replayed: true });
    expect(mail.sendErrorAlertEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendErrorAlertEmail.mock.calls[1][0].recipients).toEqual(policy.ADMIN_ALERTS_EMAIL);
  });

  it('accepts production status from only a production CI push', async () => {
    const production = {
      ref: 'refs/heads/production',
      workflow_ref: policy.repository + '/.github/workflows/ci.yml@refs/heads/production',
      event_name: 'push',
    };
    const mail = { sendErrorAlertEmail: jest.fn().mockResolvedValue({ accepted: true }) };
    const controller = new ReleaseAlertController(mail as any);
    const body = { runId: '12345', revision, kind: 'production-success' as const };
    await expect(controller.notify('Bearer ' + token(), body)).rejects.toMatchObject({ status: 403 });
    await expect(controller.notify('Bearer ' + token({ ...production, event_name: 'pull_request' }), body))
      .rejects.toMatchObject({ status: 401 });
    await expect(controller.notify('Bearer ' + token(production), body)).resolves.toMatchObject({ accepted: true });
    expect(mail.sendErrorAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'CrimFig production ad delivery check passed',
      recipients: policy.ADMIN_ALERTS_EMAIL,
    }));
  });

  it('enforces identity and body validation over real HTTP before submitting mail', async () => {
    const mail = { sendErrorAlertEmail: jest.fn().mockResolvedValue({ accepted: true }) };
    @Module({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [ReleaseAlertController], providers: [{ provide: EmailService, useValue: mail }],
    }) class AlertFixture {}
    const app = await NestFactory.create(AlertFixture, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0, '127.0.0.1');
    const address = await app.getUrl();
    const post = async (body: object, authorization?: string) => new Promise<number>((resolve, reject) => {
      const req = request(new URL('/api/v1/health/release-alert', address), {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    try {
      const body = { runId: '12345', revision, kind: 'test' };
      expect(await post(body)).toBe(401);
      expect(await post({ ...body, runId: 'bad' }, 'Bearer ' + token())).toBe(400);
      expect(mail.sendErrorAlertEmail).not.toHaveBeenCalled();
      expect(await post(body, 'Bearer ' + token())).toBe(201);
      expect(mail.sendErrorAlertEmail).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
