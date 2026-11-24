import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdsRoles } from '../security/ads-staff-grants';
import { ProgramControlsService, ReserveBucket } from './program-controls.service';

class ToggleSwitchDto {
  @IsBoolean() enabled: boolean;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsUUID() requestId: string;
}

class ReserveTransferDto {
  @IsIn(['platform_operating_reserve', 'promotional_ad_reserve', 'rewards_fund_available', 'cfig_conversion_reserve'])
  fromReserve: ReserveBucket;
  @IsIn(['platform_operating_reserve', 'promotional_ad_reserve', 'rewards_fund_available', 'cfig_conversion_reserve'])
  toReserve: ReserveBucket;
  @IsInt() @IsPositive() amountCents: number;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsUUID() requestId: string;
}

class OperatingProceedsDto {
  @IsInt() @IsPositive() amountCents: number;
  @IsString() @MinLength(3) @MaxLength(128) sourceRef: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsUUID() requestId: string;
}

class ManualCommitmentDto {
  @IsIn(['platform_operating_reserve', 'promotional_ad_reserve', 'rewards_fund_available', 'cfig_conversion_reserve'])
  targetPool: ReserveBucket;
  @IsInt() @IsPositive() amountCents: number;
  @IsString() @MinLength(3) @MaxLength(128) commitmentRef: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsUUID() requestId: string;
}

@ApiTags('Admin Rewards Controls & Reserves')
@AdsRoles('super_admin', 'ads_finance')
@Controller('admin/rewards/controls')
export class AdminRewardsControlsController {
  constructor(private readonly controls: ProgramControlsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get program switches, all reserves, transfer history, and silent safety alerts' })
  async overview(@Req() req: any) {
    const canManualSeedCommitment =
      Array.isArray(req?.platformRoles) && req.platformRoles.includes('super_admin');
    return { status: 'success', data: await this.controls.getAdminOverview(canManualSeedCommitment) };
  }

  @Post('switches/:key')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Enable or disable an audited program switch' })
  async toggleSwitch(
    @Req() req: any,
    @Param('key') key: string,
    @Body() body: ToggleSwitchDto,
  ) {
    return {
      status: 'success',
      data: await this.controls.toggleSwitch(req.user.sub, key, body),
    };
  }

  @Post('reserves/transfer')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Transfer cash between Platform Operating Reserve, Promotional Ad Reserve, and Rewards Fund' })
  async transferReserves(@Req() req: any, @Body() body: ReserveTransferDto) {
    return {
      status: 'success',
      data: await this.controls.transferBetweenReserves(req.user.sub, body),
    };
  }

  @Post('reserves/operating-proceeds')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record realized platform proceeds into Platform Operating Reserve' })
  async recordOperatingProceeds(@Req() req: any, @Body() body: OperatingProceedsDto) {
    return {
      status: 'success',
      data: await this.controls.recordOperatingProceeds(req.user.sub, body),
    };
  }

  @AdsRoles('super_admin')
  @Post('reserves/manual-commitment')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record an explicit single super_admin owner seed commitment into any reward or operating reserve pool (no gateway deposit)' })
  async recordManualCommitment(@Req() req: any, @Body() body: ManualCommitmentDto) {
    return {
      status: 'success',
      data: await this.controls.recordManualCommitment(req.user.sub, body),
    };
  }

  @Post('alerts/:id/acknowledge')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Acknowledge a silent platform safety alert' })
  async acknowledgeAlert(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return {
      status: 'success',
      data: await this.controls.acknowledgeAlert(req.user.sub, id),
    };
  }
}
