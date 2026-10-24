import { Controller, Get, Post, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdvertiserMilestonesService } from './advertiser-milestones.service';

@ApiTags('Advertiser Milestones')
@Controller('advertiser/milestones')
export class AdvertiserMilestonesController {
  constructor(private readonly milestonesService: AdvertiserMilestonesService) {}

  @Get()
  @ApiOperation({ summary: 'Get current advertiser achievements, badges, and bonus credit balances' })
  async getAchievements(@Req() req: any) {
    const userId = req.user.sub;
    const result = await this.milestonesService.getAdvertiserAchievements(userId);
    return { status: 'success', data: result };
  }

  @Post('evaluate')
  @ApiOperation({ summary: 'Trigger evaluation of eligible advertiser milestone achievements' })
  async evaluateAchievements(@Req() req: any) {
    const userId = req.user.sub;
    const result = await this.milestonesService.evaluateCategoryAMilestones(userId);
    return { status: 'success', data: result };
  }
}
