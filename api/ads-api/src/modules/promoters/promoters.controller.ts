import { Controller, Get, Post, Put, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PromotersService } from './promoters.service';
import { IsString, IsIn, IsOptional, IsBoolean } from 'class-validator';

export class RegisterPromoterDto {
  @IsIn(['WEBSITE', 'INDIVIDUAL', 'MOBILE_APP'])
  type: 'WEBSITE' | 'INDIVIDUAL' | 'MOBILE_APP';

  @IsOptional()
  @IsString()
  displayName?: string;
}

export class AddWebsiteDto {
  @IsString()
  url: string;

  @IsString()
  domain: string;

  @IsIn(['dns_txt', 'html_file_and_meta_tag'])
  verificationMethod: 'dns_txt' | 'html_file_and_meta_tag';
}

export class AddMobileAppDto {
  @IsString()
  appName: string;

  @IsString()
  bundleId: string;

  @IsIn(['ios', 'android', 'both'])
  platform: 'ios' | 'android' | 'both';

  @IsOptional()
  @IsString()
  storeUrl?: string;
}

@ApiTags('Promoters')
@Controller('promoters')
export class PromotersController {
  constructor(private readonly promotersService: PromotersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get or auto-initialize promoter profile for current user' })
  async getProfile(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const profile = await this.promotersService.getOrCreatePromoter(userId);
    return { status: 'success', data: profile };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register/set promoter profile type' })
  async register(@Req() req: any, @Body() dto: RegisterPromoterDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const profile = await this.promotersService.getOrCreatePromoter(userId, dto.type, dto.displayName);
    return { status: 'success', data: profile };
  }

  @Get('websites')
  @ApiOperation({ summary: 'List registered websites' })
  async getWebsites(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const websites = await this.promotersService.getWebsites(promoter.id);
    return { status: 'success', data: websites };
  }

  @Post('websites')
  @ApiOperation({ summary: 'Register a website for embed codes' })
  async addWebsite(@Req() req: any, @Body() dto: AddWebsiteDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const website = await this.promotersService.addWebsite(promoter.id, dto);
    return { status: 'success', data: website };
  }

  @Get('apps')
  @ApiOperation({ summary: 'List registered mobile apps' })
  async getApps(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'MOBILE_APP');
    const apps = await this.promotersService.getMobileApps(promoter.id);
    return { status: 'success', data: apps };
  }

  @Post('apps')
  @ApiOperation({ summary: 'Register a mobile app for ad SDK' })
  async addApp(@Req() req: any, @Body() dto: AddMobileAppDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'MOBILE_APP');
    const app = await this.promotersService.addMobileApp(promoter.id, dto);
    return { status: 'success', data: app };
  }

  @Get('reels-consent')
  @ApiOperation({ summary: 'Get Reels auto-posting consent status' })
  async getReelsConsent(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'INDIVIDUAL');
    const consent = await this.promotersService.getReelsConsent(promoter.id);
    return { status: 'success', data: consent };
  }

  @Put('reels-consent')
  @ApiOperation({ summary: 'Update Reels auto-posting consent' })
  async setReelsConsent(@Req() req: any, @Body('consent') consent: boolean) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'INDIVIDUAL');
    const updated = await this.promotersService.setReelsConsent(promoter.id, consent);
    return { status: 'success', data: updated };
  }
}
