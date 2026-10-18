import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { TokensService } from './tokens.service';
import { DATABASE_TOKEN } from '../database/database.module';

describe('TokensService', () => {
  let service: TokensService;
  let mockDb: any;
  let mockJwtService: any;

  beforeEach(async () => {
    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock_jwt_token'),
      verify: jest.fn().mockReturnValue({ sub: 'user_123', email: 'test@crimfig.com', type: 'access' }),
    };

    mockDb = {
      query: {
        users: {
          findFirst: jest.fn(),
        },
        apps: {
          findFirst: jest.fn(),
        },
        refreshTokens: {
          findFirst: jest.fn(),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 'auto_provisioned_app_id' }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue({}),
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokensService,
        { provide: DATABASE_TOKEN, useValue: mockDb },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<TokensService>(TokensService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('issueTokenPair', () => {
    it('should issue tokens successfully when app exists in database', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user_123', email: 'test@crimfig.com' });
      mockDb.query.apps.findFirst.mockResolvedValue({ id: 'existing_app_id' });

      const result = await service.issueTokenPair('user_123', 'crimfig_auth');

      expect(result).toHaveProperty('accessToken', 'mock_jwt_token');
      expect(result).toHaveProperty('refreshToken');
      expect(result.expiresIn).toBe(900);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should auto-provision app when app does not exist in database and prevent 500 crashes', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user_123', email: 'test@crimfig.com' });
      // App initially not found in database
      mockDb.query.apps.findFirst.mockResolvedValueOnce(null);

      const result = await service.issueTokenPair('user_123', 'crimfig_auth');

      expect(result).toHaveProperty('accessToken', 'mock_jwt_token');
      expect(result).toHaveProperty('refreshToken');
      // Proves insert was called for auto-provisioning
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if user is not found', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(service.issueTokenPair('nonexistent_user', 'crimfig_auth')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('issueMfaChallengeToken', () => {
    it('should issue an MFA challenge token when user exists', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user_123', email: 'test@crimfig.com' });

      const token = await service.issueMfaChallengeToken('user_123');
      expect(token).toBe('mock_jwt_token');
      expect(mockJwtService.sign).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when user does not exist', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(service.issueMfaChallengeToken('user_not_found')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
