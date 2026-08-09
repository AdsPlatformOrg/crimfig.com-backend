import { IsEmail, IsString, MinLength, IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — Common Request/Response DTOs
// ─────────────────────────────────────────────────────────────────────────────

// ── Auth DTOs ────────────────────────────────────────────────────────────────

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'superSecretPassword123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ description: 'OAuth client_id of the requesting app', example: 'crimfig_ads' })
  @IsOptional()
  @IsString()
  clientId?: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'superSecretPassword123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  phone?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Opaque refresh token issued at login' })
  @IsString()
  refreshToken!: string;
}

export class MfaChallengeDto {
  @ApiProperty({ description: 'TOTP 6-digit code or passkey assertion JSON' })
  @IsString()
  code!: string;

  @ApiPropertyOptional({ description: 'MFA device ID being challenged', example: 'uuid-...' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

// ── Token Response DTO ────────────────────────────────────────────────────────

export class TokenPairResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ description: 'Access token TTL in seconds', example: 900 })
  expiresIn!: number;
}

// ── Pagination DTOs ───────────────────────────────────────────────────────────

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ── Organization DTOs ──────────────────────────────────────────────────────────

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({ example: 'acme-corp', description: 'URL-safe slug (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: 'A leading provider of Acme products' })
  @IsOptional()
  @IsString()
  description?: string;
}
