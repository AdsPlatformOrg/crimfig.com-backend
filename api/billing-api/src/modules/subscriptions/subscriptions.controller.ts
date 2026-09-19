import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { IsString, IsIn, IsOptional } from 'class-validator';
import { Public } from '@crimfig/shared';

export class SubscribeDto {
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

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subsService: SubscriptionsService) {}

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
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const subs = await this.subsService.getUserSubscriptions(userId);
    return { status: 'success', data: subs };
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Subscribe to an app plan' })
  async subscribe(@Req() req: any, @Body() dto: SubscribeDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const userEmail = req.user?.email || req.headers['x-user-email'] || 'user@crimfig.com';
    const appSlug = dto.appSlug || dto.appName || 'chat';

    const result = await this.subsService.subscribe({
      userId,
      userEmail,
      appSlug,
      planId: dto.planId,
      interval: dto.interval,
      savedCardId: dto.savedCardId,
    });

    return { status: 'success', data: result };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a subscription' })
  async cancel(@Param('id') subId: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.subsService.cancelSubscription(userId, subId);
    return { status: 'success', data: result };
  }
}
