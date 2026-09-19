import {
  Controller, Post, Get, Body, UseGuards, HttpCode, HttpStatus, Req, Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, MinLength, Length, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { MfaChallengeGuard } from '../../guards/mfa-challenge.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { config } from '../../config/config';
import type { JwtPayload } from '../tokens/tokens.service';

// ── DTOs ──────────────────────────────────────────────────────────────────────

class ConfirmTotpDto {
  @ApiProperty({ description: '6-digit TOTP code from authenticator app', example: '123456' })
  @IsString()
  @Length(6, 8)
  code!: string;
}

class VerifyMfaDto {
  @ApiProperty({ description: '6-digit TOTP code or 8-char backup code' })
  @IsString()
  @MinLength(6)
  code!: string;

  @ApiPropertyOptional({ description: 'Target client ID for token issuance', default: 'crimfig_auth' })
  @IsOptional()
  @IsString()
  clientId?: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('MFA')
@Controller({ path: 'mfa', version: '1' })
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current MFA status for the authenticated user' })
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.mfaService.getMfaStatus(user.sub);
  }

  @Post('totp/enroll')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate TOTP enrollment — returns QR code and secret' })
  initiateTotpEnrollment(@CurrentUser() user: JwtPayload) {
    return this.mfaService.initiateTotpEnrollment(user.sub, user.email);
  }

  @Post('totp/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm TOTP enrollment with first authenticator code' })
  confirmTotpEnrollment(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return this.mfaService.confirmTotpEnrollment(user.sub, user.email, dto.code);
  }

  @Post('verify')
  @UseGuards(MfaChallengeGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify MFA during login challenge and issue token pair' })
  async verifyChallenge(
    @CurrentUser() user: JwtPayload,
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const fingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const tokens = await this.mfaService.verifyLoginChallenge(
      user.sub,
      dto.code,
      dto.clientId ?? 'crimfig_auth',
      fingerprint,
    );

    res.cookie('crimfig_rt', tokens.refreshToken, {
      httpOnly: true,
      secure: config.IS_PRODUCTION,
      sameSite: 'strict',
      maxAge: config.JWT.REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
      domain: config.SECURITY.COOKIE_DOMAIN,
      path: '/api/v1/auth',
    });

    return tokens;
  }

  @Post('totp/disable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable MFA (requires valid TOTP or backup code to confirm)' })
  disableMfa(@CurrentUser() user: JwtPayload, @Body() dto: VerifyMfaDto) {
    return this.mfaService.disableMfa(user.sub, dto.code);
  }
}

