import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AdClearanceService } from './ad-clearance.service';

export class PrepareAdClearanceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evidenceId: string;
}

export class ApproveAdClearanceDto {
  @IsUUID('4')
  draftId: string;
}

/** Global BillingAccessGuard authenticates; service checks explicit operator grants and current status. */
@ApiTags('Ad settlement clearance')
@Controller('ad-settlements/items')
export class AdClearanceController {
  constructor(private readonly clearance: AdClearanceService) {}

  @Get(':itemId/review')
  @ApiOperation({ summary: 'Granted operator: inspect held earnings and immutable review evidence' })
  async read(@Req() req: any, @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string) {
    return { status: 'success', data: await this.clearance.read(req.user.sub, itemId) };
  }

  @Post(':itemId/review')
  @ApiOperation({ summary: 'Granted operator: prepare independent clearance after the 72-hour hold' })
  async prepare(@Req() req: any, @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: PrepareAdClearanceDto) {
    return { status: 'success', data: await this.clearance.prepare(req.user.sub, itemId, dto.evidenceId) };
  }

  @Post(':itemId/review/approve')
  @ApiOperation({ summary: 'Independent granted operator: atomically release reviewed publisher earnings once' })
  async approve(@Req() req: any, @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: ApproveAdClearanceDto) {
    return { status: 'success', data: await this.clearance.approve(req.user.sub, itemId, dto.draftId) };
  }
}
