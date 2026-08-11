import { Controller, Post, Get, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { ConsentService, RecordConsentDto } from './consent.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';

@ApiTags('Consent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'consent', version: '1' })
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Post()
  @ApiOperation({ summary: 'Record user consent to app Terms of Service' })
  recordConsent(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ) {
    return this.consentService.recordConsent(user.sub, dto, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Get(':appClientId')
  @ApiOperation({ summary: 'Get consent status for a specific app' })
  getConsent(@CurrentUser() user: JwtPayload, @Param('appClientId') appClientId: string) {
    return this.consentService.getConsent(user.sub, appClientId);
  }
}
