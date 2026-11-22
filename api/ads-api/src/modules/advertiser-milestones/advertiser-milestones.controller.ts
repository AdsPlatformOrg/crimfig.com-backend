import { Body, Controller, Get, Post, Req, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsBoolean, IsString, IsUUID } from 'class-validator';
import { AdvertiserMilestonesService } from './advertiser-milestones.service';

class ClaimBonusCreditDto {
  @IsString() milestoneId: string;
  @IsUUID() requestId: string;
  @IsBoolean() acceptTerms: boolean;
}

@ApiTags('Advertiser Milestones')
@Controller('advertiser/milestones')
export class AdvertiserMilestonesController {
  constructor(private readonly milestonesService: AdvertiserMilestonesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get current advertiser achievements, badges, and bonus credit balances' })
  async getAchievements(@Req() req: any) {
    const userId = req.user.sub;
    const result = await this.milestonesService.getAdvertiserAchievements(userId);
    return { status: 'success', data: result };
  }

  @Post('evaluate')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Evaluate verified recognition badges without issuing credit' })
  async evaluateAchievements(@Req() req: any) {
    const userId = req.user.sub;
    const result = await this.milestonesService.evaluateCategoryAMilestones(userId);
    return { status: 'success', data: result };
  }

  @Post('claim')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Claim unlocked advertiser milestone bonus ad credit (no deadline, no expiry)' })
  async claimBonusCredit(@Req() req: any, @Body() body: ClaimBonusCreditDto) {
    const userId = req.user.sub;
    const result = await this.milestonesService.claimMilestoneBonus(userId, body);
    return { status: 'success', data: result };
  }
}
