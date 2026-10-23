import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { AdRejectionService } from './ad-rejection.service';
import { ApproveAdClearanceDto, PrepareAdClearanceDto } from './ad-clearance.controller';

export class DismissAdRejectionDto extends PrepareAdClearanceDto {
  @IsUUID('4')
  draftId: string;
}

@ApiTags('Ad settlement rejection')
@Controller('ad-settlements/escrows/:escrowId/promoters/:promoterId/rejection')
export class AdRejectionController {
  constructor(private readonly rejection: AdRejectionService) {}

  @Get()
  @ApiOperation({ summary: 'Operator: inspect immutable rejection evidence and recovery decisions' })
  async read(@Req() req: any,
    @Param('escrowId', new ParseUUIDPipe({ version: '4' })) escrowId: string,
    @Param('promoterId', new ParseUUIDPipe({ version: '4' })) promoterId: string) {
    return { status: 'success', data: await this.rejection.read(req.user.sub, escrowId, promoterId) };
  }

  @Post('dismiss')
  @ApiOperation({ summary: 'Independent operator: dismiss an unexecuted rejection with evidence and resume settlement' })
  async dismiss(@Req() req: any,
    @Param('escrowId', new ParseUUIDPipe({ version: '4' })) escrowId: string,
    @Param('promoterId', new ParseUUIDPipe({ version: '4' })) promoterId: string,
    @Body() dto: DismissAdRejectionDto) {
    return { status: 'success', data: await this.rejection.dismiss(req.user.sub, escrowId, promoterId, dto.draftId, dto.evidenceId) };
  }

  @Post()
  @ApiOperation({ summary: 'Operator: freeze and prepare evidence-bound rejection of an entire held publisher claim chain' })
  async prepare(@Req() req: any,
    @Param('escrowId', new ParseUUIDPipe({ version: '4' })) escrowId: string,
    @Param('promoterId', new ParseUUIDPipe({ version: '4' })) promoterId: string,
    @Body() dto: PrepareAdClearanceDto) {
    return { status: 'success', data: await this.rejection.prepare(req.user.sub, escrowId, promoterId, dto.evidenceId) };
  }

  @Post('approve')
  @ApiOperation({ summary: 'Independent operator: invalidate reviewed claims and refund proven funded spend once' })
  async approve(@Req() req: any,
    @Param('escrowId', new ParseUUIDPipe({ version: '4' })) escrowId: string,
    @Param('promoterId', new ParseUUIDPipe({ version: '4' })) promoterId: string,
    @Body() dto: ApproveAdClearanceDto) {
    return { status: 'success', data: await this.rejection.approve(req.user.sub, escrowId, promoterId, dto.draftId) };
  }
}
