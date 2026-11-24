jest.mock('../../src/config/config', () => ({
  config: {
    APP: { AUTH_WEB_URL: 'https://auth.crimfig.com' },
    ENCRYPTION: { KEY: '0'.repeat(64) },
  },
}));

import { ServiceUnavailableException } from '@nestjs/common';
import { OAuthController } from '../../src/modules/oauth/oauth.controller';
import { ConsentController } from '../../src/modules/consent/consent.controller';
import { OrganizationsController } from '../../src/modules/organizations/organizations.controller';

describe('PLAN-0162 Coming-Soon Controller Gates', () => {
  it('blocks all OAuth 2.0 / PKCE HTTP endpoints before touching OAuthService', async () => {
    const oauthService = {
      validateAuthorization: jest.fn(),
      generateAuthCode: jest.fn(),
      exchangeCodeForTokens: jest.fn(),
      getUserInfo: jest.fn(),
    };
    const controller = new OAuthController(oauthService as any);
    const res = { redirect: jest.fn() };

    await expect(
      controller.authorize(
        {
          client_id: 'app_1',
          redirect_uri: 'https://ads.crimfig.com/cb',
          response_type: 'code',
        } as any,
        res as any,
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    await expect(
      controller.approveAuthorization(
        { sub: 'usr_1', email: 'u@crimfig.com', type: 'access' },
        { client_id: 'app_1', redirect_uri: 'https://ads.crimfig.com/cb', response_type: 'code' } as any,
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    await expect(
      controller.token({
        grant_type: 'authorization_code',
        client_id: 'app_1',
        redirect_uri: 'https://ads.crimfig.com/cb',
        code: 'code_1',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(() => controller.userInfo('Bearer tok')).toThrow(ServiceUnavailableException);

    expect(oauthService.validateAuthorization).not.toHaveBeenCalled();
    expect(oauthService.generateAuthCode).not.toHaveBeenCalled();
    expect(oauthService.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(oauthService.getUserInfo).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('blocks App ToS Consent endpoints before touching ConsentService', () => {
    const consentService = {
      recordConsent: jest.fn(),
      getConsent: jest.fn(),
    };
    const controller = new ConsentController(consentService as any);

    expect(() =>
      controller.recordConsent(
        { sub: 'usr_1', email: 'u@crimfig.com', type: 'access' },
        { appClientId: 'crimfig_ads', termsVersion: '1.0.0' } as any,
        { ip: '127.0.0.1', headers: {} } as any,
      ),
    ).toThrow(ServiceUnavailableException);

    expect(() =>
      controller.getConsent({ sub: 'usr_1', email: 'u@crimfig.com', type: 'access' }, 'crimfig_ads'),
    ).toThrow(ServiceUnavailableException);

    expect(consentService.recordConsent).not.toHaveBeenCalled();
    expect(consentService.getConsent).not.toHaveBeenCalled();
  });

  it('blocks all Organizations and invite endpoints before touching OrganizationsService', () => {
    const orgService = {
      createOrg: jest.fn(),
      getUserOrgs: jest.fn(),
      getOrgMembers: jest.fn(),
      inviteMember: jest.fn(),
      acceptInvite: jest.fn(),
      removeMember: jest.fn(),
    };
    const controller = new OrganizationsController(orgService as any);
    const user = { sub: 'usr_1', email: 'u@crimfig.com', type: 'access' as const };

    expect(() => controller.createOrg(user, { name: 'Acme' } as any)).toThrow(ServiceUnavailableException);
    expect(() => controller.getMyOrgs(user)).toThrow(ServiceUnavailableException);
    expect(() => controller.getMembers('org_1')).toThrow(ServiceUnavailableException);
    expect(() => controller.inviteMember(user, 'org_1', { email: 'a@b.com', role: 'member' } as any)).toThrow(
      ServiceUnavailableException,
    );
    expect(() => controller.acceptInvite(user, { token: 'inv_1' } as any)).toThrow(ServiceUnavailableException);
    expect(() => controller.removeMember(user, 'org_1', 'usr_2')).toThrow(ServiceUnavailableException);

    expect(orgService.createOrg).not.toHaveBeenCalled();
    expect(orgService.getUserOrgs).not.toHaveBeenCalled();
    expect(orgService.getOrgMembers).not.toHaveBeenCalled();
    expect(orgService.inviteMember).not.toHaveBeenCalled();
    expect(orgService.acceptInvite).not.toHaveBeenCalled();
    expect(orgService.removeMember).not.toHaveBeenCalled();
  });
});
