import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TokensService } from '../tokens/tokens.service';
import { EmailService } from '../email/email.service';
import { DATABASE_TOKEN } from '../database/database.module';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';

jest.mock('argon2');
jest.mock('../../config/config', () => ({
  config: {
    JWT: { ACCESS_SECRET: 'auth-service-test-secret' },
  }
}));

describe('AuthService', () => {
  let service: AuthService;
  let mockDb: any;
  let mockTokensService: any;
  let mockEmailService: any;

  beforeEach(async () => {
    mockDb = {
      query: {
        users: {
          findFirst: jest.fn(),
        },
        individualProfiles: {
          findFirst: jest.fn(),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 'new_user_id', email: 'new@crimfig.com' }]),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue({}),
        }),
      }),
    };

    mockTokensService = {
      issueTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access_123',
        refreshToken: 'refresh_123',
        expiresIn: 900,
      }),
      issueMfaChallengeToken: jest.fn().mockResolvedValue('mfa_challenge_123'),
      revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
    };

    mockEmailService = {
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DATABASE_TOKEN, useValue: mockDb },
        { provide: TokensService, useValue: mockTokensService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('binds logout revocation to the authenticated owner', async () => {
    await service.logout('signed-in-user', 'cookie-token');
    expect(mockTokensService.revokeRefreshToken).toHaveBeenCalledWith('cookie-token', 'signed-in-user');
  });

  describe('login', () => {
    it('should successfully log in user with valid credentials and return tokens', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'usr_valid',
        email: 'test@crimfig.com',
        passwordHash: '$argon2id$mockedhash',
        status: 'ACTIVE',
        mfaEnabled: false,
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      const result = await service.login({ email: 'test@crimfig.com', password: 'ValidPassword123!' });

      expect(result).toHaveProperty('requiresMfa', false);
      expect(result).toHaveProperty('accessToken', 'access_123');
      expect(result).toHaveProperty('refreshToken', 'refresh_123');
      expect(mockTokensService.issueTokenPair).toHaveBeenCalledWith('usr_valid', 'crimfig_auth', undefined);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should require MFA challenge token when mfaEnabled is true', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'usr_mfa',
        email: 'mfa@crimfig.com',
        passwordHash: '$argon2id$mockedhash',
        status: 'ACTIVE',
        mfaEnabled: true,
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      const result = await service.login({ email: 'mfa@crimfig.com', password: 'ValidPassword123!' });

      expect(result).toEqual({
        requiresMfa: true,
        mfaChallengeToken: 'mfa_challenge_123',
      });
      expect(mockTokensService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when password verification fails', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'usr_valid',
        email: 'test@crimfig.com',
        passwordHash: '$argon2id$mockedhash',
        status: 'ACTIVE',
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: 'test@crimfig.com', password: 'WrongPassword!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when account is suspended', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'usr_suspended',
        email: 'suspended@crimfig.com',
        passwordHash: '$argon2id$mockedhash',
        status: 'SUSPENDED',
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      await expect(
        service.login({ email: 'suspended@crimfig.com', password: 'Password123!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when user does not exist', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ email: 'notfound@crimfig.com', password: 'Password123!' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('signup', () => {
    it('should throw ConflictException if email is already registered', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'existing_user' });

      await expect(
        service.signup({ email: 'existing@crimfig.com', password: 'SecurePassword123!' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
