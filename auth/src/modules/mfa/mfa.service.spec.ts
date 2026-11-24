jest.mock('otplib', () => ({ verifySync: jest.fn(), generateSecret: jest.fn(), generateURI: jest.fn() }));
jest.mock('../../config/config', () => ({
  config: {
    ENCRYPTION: { KEY: '0'.repeat(64) },
  },
}));

import { ServiceUnavailableException } from '@nestjs/common';
import { MfaService } from './mfa.service';

describe('MfaService (PLAN-0157)', () => {
  it('fails closed on TOTP enrollment and confirmation without touching the database', async () => {
    const db = {
      query: { mfaDevices: { findFirst: jest.fn(), findMany: jest.fn() } },
      insert: jest.fn(),
      update: jest.fn(),
    };
    const emailService = { sendMfaBackupCodesEmail: jest.fn() };
    const tokensService = { issueTokenPair: jest.fn() };
    const service = new MfaService(db as any, emailService as any, tokensService as any);

    await expect(service.initiateTotpEnrollment('usr_1', 'user@crimfig.com')).rejects.toThrow(ServiceUnavailableException);
    await expect(service.confirmTotpEnrollment('usr_1', 'user@crimfig.com', '123456')).rejects.toThrow(ServiceUnavailableException);
    await expect(service.verifyLoginChallenge('usr_1', '123456', 'crimfig_auth')).rejects.toThrow(ServiceUnavailableException);
    await expect(service.disableMfa('usr_1', '123456')).rejects.toThrow(ServiceUnavailableException);
    expect(db.query.mfaDevices.findFirst).not.toHaveBeenCalled();
    expect(db.query.mfaDevices.findMany).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(emailService.sendMfaBackupCodesEmail).not.toHaveBeenCalled();
    expect(tokensService.issueTokenPair).not.toHaveBeenCalled();
  });

  it('reports enrollmentAvailable as false in getMfaStatus while preserving account status fields', async () => {
    const db = {
      query: {
        mfaDevices: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    };
    const service = new MfaService(db as any, {} as any, {} as any);

    await expect(service.getMfaStatus('usr_1')).resolves.toEqual({
      mfaEnabled: false,
      totpConfigured: false,
      backupCodesRemaining: 0,
      enrollmentAvailable: false,
    });
  });
});
