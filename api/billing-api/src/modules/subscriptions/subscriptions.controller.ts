import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SubscriptionPaymentsService } from './subscription-payments.service';
import { SubscriptionsService } from './subscriptions.service';
import { IsString, IsIn, IsOptional, IsUUID, IsInt, Min, Max, IsISO8601 } from 'class-validator';
import { Public } from '@crimfig/shared';

export class SubscribeDto {
  @IsUUID('4')
  requestId: string;

  @IsOptional()
  @IsString()
  appSlug?: string;

  @IsOptional()
  @IsString()
  appName?: string;

  @IsString()
  planId: string;

  @IsIn(['monthly', 'annual'])
  interval: 'monthly' | 'annual';

  @IsOptional()
  @IsString()
  savedCardId?: string;
}

export class RenewalConsentDto {
  @IsUUID('4') requestId: string;
  @IsUUID() savedCardId: string;
  @IsInt() @Min(1) @Max(2147483647) maxNgnKobo: number;
  @IsISO8601() expectedPeriodEnd: string;
}

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subsService: SubscriptionsService, private readonly payments: SubscriptionPaymentsService) {}

  @Public()
  @Get('catalog')
  @ApiOperation({ summary: 'Get available subscription plans for apps' })
  getCatalog(@Query('appSlug') appSlug?: string, @Query('appName') appName?: string) {
    const plans = this.subsService.getCatalog(appSlug || appName);
    return { status: 'success', data: plans };
  }

  @Get()
  @ApiOperation({ summary: 'List user subscriptions across apps' })
  async getUserSubscriptions(@Req() req: any) {
    const userId = req.user.sub;
    const subs = await this.subsService.getUserSubscriptions(userId);
    return { status: 'success', data: subs };
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Subscribe to an app plan' })
  async subscribe(@Req() req: any, @Body() dto: SubscribeDto) {
    const userId = req.user.sub;
    const userEmail = req.user.email;
    const appSlug = dto.appSlug || dto.appName || 'chat';

    const result = await this.subsService.subscribe({
      userId,
      userEmail,
      appSlug,
      planId: dto.planId,
      interval: dto.interval,
      savedCardId: dto.savedCardId,
      requestId: dto.requestId,
    });

    return { status: 'success', data: result };
  }

  @Get('requests/:requestId')
  async recover(@Req() req: any, @Param('requestId') requestId: string) {
    return { status: 'success', data: await this.payments.recover(req.user.sub, requestId) };
  }

  @Get('entitlements/:appSlug')
  async entitlement(@Req() req: any, @Param('appSlug') appSlug: string) {
    return { status: 'success', data: await this.payments.entitlement(req.user.sub, appSlug) };
  }

  @Get('payments/:reference')
  async recoverPayment(@Req() req: any, @Param('reference') reference: string) {
    return { status: 'success', data: await this.payments.recoverReference(req.user.sub, reference) };
  }

  @Post(':id/renewal-consent')
  async renewalConsent(@Req() req: any, @Param('id') id: string, @Body() dto: RenewalConsentDto) {
    return { status: 'success', data: await this.payments.consent(req.user.sub, id, dto) };
  }

  @Get(':id/preferences')
  async preferences(@Req() req: any, @Param('id') id: string) {
    return { status: 'success', data: await this.payments.preferences(req.user.sub, id) };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a subscription' })
  async cancel(@Param('id') subId: string, @Req() req: any) {
    const userId = req.user.sub;
    const result = await this.subsService.cancelSubscription(userId, subId);
    return { status: 'success', data: result };
  }
}
