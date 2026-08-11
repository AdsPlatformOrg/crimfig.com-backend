import {
  Controller, Post, Get, Body, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, MinLength, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
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
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('MFA')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'mfa', version: '1' })
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current MFA status for the authenticated user' })
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.mfaService.getMfaStatus(user.sub);
  }

  @Post('totp/enroll')
  @ApiOperation({ summary: 'Initiate TOTP enrollment — returns QR code and secret' })
  initiateTotpEnrollment(@CurrentUser() user: JwtPayload) {
    return this.mfaService.initiateTotpEnrollment(user.sub, user.email);
  }

  @Post('totp/confirm')
  @ApiOperation({ summary: 'Confirm TOTP enrollment with first authenticator code' })
  confirmTotpEnrollment(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return this.mfaService.confirmTotpEnrollment(user.sub, user.email, dto.code);
  }

  @Post('totp/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable MFA (requires valid TOTP or backup code to confirm)' })
  disableMfa(@CurrentUser() user: JwtPayload, @Body() dto: VerifyMfaDto) {
    return this.mfaService.disableMfa(user.sub, dto.code);
  }
}
