import { Controller, Post, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { VerificationService } from './verification.service';
import { PromotersService } from '../promoters/promoters.service';

@ApiTags('Verification')
@Controller('verification')
export class VerificationController {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly promotersService: PromotersService,
  ) {}

  @Post('website/:websiteId')
  @ApiOperation({ summary: 'Trigger domain verification for a website' })
  async verifyWebsite(@Param('websiteId') websiteId: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const result = await this.verificationService.verifyWebsite(promoter.id, websiteId);
    return { status: 'success', data: result };
  }

  @Post('app/:appId')
  @ApiOperation({ summary: 'Trigger verification for a mobile app' })
  async verifyApp(@Param('appId') appId: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'MOBILE_APP');
    const result = await this.verificationService.verifyMobileApp(promoter.id, appId);
    return { status: 'success', data: result };
  }
}
