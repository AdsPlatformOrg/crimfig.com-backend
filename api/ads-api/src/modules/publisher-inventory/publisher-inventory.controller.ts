import { documentAdsController } from '../../contracts/ads-contract';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, IsISO8601, MaxLength, ArrayMaxSize,IsInt,Min,Max } from 'class-validator';
import { PromotersService } from '../promoters/promoters.service';
import { SetupChecksService } from './setup-checks.service';
import { CreateSetupCheckDto } from './create-setup-check.dto';
import { availablePublisherAdTypes } from '../../../../billing-api/src/modules/ecosystem/creative-slot-policy';
import { PublisherSlotsService, UpdateAdstationSlotDto } from './publisher-slots.service';

export class CreateSlotDto {
  @IsUUID()
  websiteId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsIn(['consideration', 'direct', 'network', 'hybrid'])
  slotType: 'consideration' | 'direct' | 'network' | 'hybrid';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  slotDeliveryPreference?: string;

  @IsOptional()
  @IsInt() @Min(50) @Max(3840)
  width?: number;

  @IsOptional()
  @IsInt() @Min(50) @Max(2160)
  height?: number;

  @IsOptional()
  @IsBoolean()
  responsive?: boolean;

  @IsOptional()
  @IsArray()
  allowedAdTypes?: string[];

  @IsOptional()
  @IsArray()
  allowedPresetIds?: string[];
}

export class ManagedCreateSlotDto extends CreateSlotDto {
  @IsUUID() requestId!:string;
}
export class ManagedSlotControlDto {
  @IsUUID() requestId!:string;
  @IsISO8601() expectedUpdatedAt!:string;
}
export class ManagedUpdateSlotDto extends ManagedSlotControlDto {
  @IsOptional() @IsInt() @Min(50) @Max(3840) width?:number|null;
  @IsOptional() @IsInt() @Min(50) @Max(2160) height?:number|null;
  @IsOptional() @IsString() @MaxLength(150) name?:string;
  @IsOptional() @IsIn(['draft','testing','active','paused','disabled']) lifecycleStatus?:'draft'|'testing'|'active'|'paused'|'disabled';
  @IsOptional() @IsArray() @ArrayMaxSize(9) @IsString({each:true}) allowedPresetIds?:string[];
}

@ApiTags('Publisher Inventory')
@Controller('publisher')
export class PublisherInventoryController {
  constructor(
    private readonly publisherSlots: PublisherSlotsService,
    protected readonly promotersService: PromotersService,
    private readonly setupChecks: SetupChecksService,
  ) {}

  @Post('websites/:websiteId/setup-checks')
  @ApiOperation({ summary: 'Create an owner-scoped, challenge-bound SDK setup check (idempotent by requestId)' })
  async createSetupCheck(@Req() req: any, @Param('websiteId') websiteId: string, @Body() dto: CreateSetupCheckDto) {
    const promoter = await this.promotersService.getOrCreatePromoter(req.user.sub, 'WEBSITE');
    return { status: 'success', data: await this.setupChecks.create(promoter.id, websiteId, dto) };
  }

  @Get('setup-checks/:checkId')
  @ApiOperation({ summary: 'Read explicit SDK/placement/telemetry setup evidence for an owned check' })
  async getSetupCheck(@Req() req: any, @Param('checkId') checkId: string) {
    const promoter = await this.promotersService.getOrCreatePromoter(req.user.sub, 'WEBSITE');
    return { status: 'success', data: await this.setupChecks.get(promoter.id, checkId) };
  }
  @Get('websites/:websiteId/slots')
  @ApiOperation({ summary: 'List publisher slots for website' })
  async getSlots(@Req() req: any, @Param('websiteId',new ParseUUIDPipe()) websiteId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slots = await this.publisherSlots.getSlots(promoter.id, websiteId);
    return { status: 'success', data: slots, availableAdTypes: availablePublisherAdTypes() };
  }

  @Post('slots')
  @ApiOperation({
    summary: 'Create a canonical publisher slot (consideration, network, hybrid, or direct)',
  })
  async createSlot(@Req() req: any, @Body() dto: CreateSlotDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slot = await this.publisherSlots.createSlot(promoter.id, dto);
    return { status: 'success', data: slot };
  }

  @Post('slots/managed')
  @ApiOperation({summary:'Create an owner-scoped slot with an immutable retry receipt'})
  async managedCreateSlot(@Req() req:any,@Body() dto:ManagedCreateSlotDto){
    const promoter=await this.promotersService.getExistingPromoter(req.user.sub);
    return {status:'success',data:await this.publisherSlots.managedMutation(promoter.id,'create',undefined,dto)};
  }
  @Patch('slots/:slotId/managed')
  @ApiOperation({summary:'Update slot settings with stale-edit and retry protection'})
  async managedUpdateSlot(@Req() req:any,@Param('slotId',new ParseUUIDPipe()) slotId:string,@Body() dto:ManagedUpdateSlotDto){
    const promoter=await this.promotersService.getExistingPromoter(req.user.sub);
    return {status:'success',data:await this.publisherSlots.managedMutation(promoter.id,'update',slotId,dto)};
  }
  @Delete('slots/:slotId/managed')
  @ApiOperation({summary:'Retire a slot without deleting historical delivery or financial references'})
  async managedRetireSlot(@Req() req:any,@Param('slotId',new ParseUUIDPipe()) slotId:string,@Body() dto:ManagedSlotControlDto){
    const promoter=await this.promotersService.getExistingPromoter(req.user.sub);
    return {status:'success',data:await this.publisherSlots.managedMutation(promoter.id,'retire',slotId,dto)};
  }

  @Patch('slots/:slotId')
  @ApiOperation({ summary: 'Update publisher slot lifecycle or configuration' })
  async updateSlot(
    @Req() req: any,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateAdstationSlotDto,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slot = await this.publisherSlots.updateSlot(
      promoter.id,
      slotId,
      dto,
    );
    return { status: 'success', data: slot };
  }

  @Get('slots/:slotId/embed')
  @ApiOperation({
    summary: 'Get environment-safe HTML and Next.js embed snippet for a slot',
  })
  async getSlotEmbed(@Req() req: any, @Param('slotId',new ParseUUIDPipe()) slotId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getExistingPromoter(userId);
    const embed = await this.publisherSlots.getSlotEmbedInstructions(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: embed };
  }

  @Post('slots/:slotId/check-installation')
  @ApiOperation({
    summary: 'Run evidence-driven installation check for a canonical slot',
  })
  async checkSlotInstallation(
    @Req() req: any,
    @Param('slotId') slotId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.publisherSlots.checkSlotInstallation(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: result };
  }

  @Get('slots/:slotId/diagnostics')
  @ApiOperation({
    summary: 'Get safe promoter-facing telemetry and diagnostics for a slot',
  })
  async getSlotDiagnostics(@Req() req: any, @Param('slotId') slotId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const diagnostics = await this.publisherSlots.getSlotDiagnostics(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: diagnostics };
  }

}

documentAdsController(PublisherInventoryController);
