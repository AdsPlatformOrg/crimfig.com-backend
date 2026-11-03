import { documentAdsController } from '../../contracts/ads-contract';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdsRoles } from '../security/ads-staff-grants';
import { AdsOperationsService } from './ads-operations.service';

@ApiTags('Ads Operations')
@Controller()
export class AdsOperationsController {
  constructor(private readonly operations: AdsOperationsService) {}

  @AdsRoles('ads_admin', 'super_admin')
  @Post(['adstation/admin/websites/:websiteId/suspend', 'admin/ads/websites/:websiteId/suspend'])
  @ApiOperation({ summary: 'Super Admin: Suspend website direct deal serving' })
  async suspendWebsite(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Body() dto: { reason: string },
  ) {
    const result = await this.operations.updateWebsiteAdstationStatus(
      websiteId,
      true,
      dto.reason,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin')
  @Post(['adstation/admin/websites/:websiteId/reinstate', 'admin/ads/websites/:websiteId/reinstate'])
  @ApiOperation({
    summary: 'Super Admin: Reinstate website direct deal serving',
  })
  async reinstateWebsite(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
  ) {
    const result = await this.operations.updateWebsiteAdstationStatus(
      websiteId,
      false,
      undefined,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Get(['adstation/admin/websites', 'admin/ads/websites'])
  @ApiOperation({ summary: 'Admin: List all registered promoter websites with pagination, search and filters' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'policyStatus', required: false, type: String })
  @ApiQuery({ name: 'verificationStatus', required: false, type: String })
  async adminListWebsites(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('policyStatus') policyStatus?: string,
    @Query('verificationStatus') verificationStatus?: string,
  ) {
    return {
      status: 'success',
      data: await this.operations.adminListWebsites(
        Number(page ?? 1),
        Number(pageSize ?? 25),
        search,
        policyStatus,
        verificationStatus,
      ),
    };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Get(['adstation/admin/websites/:websiteId', 'admin/ads/websites/:websiteId'])
  @ApiOperation({ summary: 'Admin: Get full inspection details for a promoter website' })
  async adminGetWebsite(
    @Param('websiteId', new ParseUUIDPipe()) websiteId: string,
  ) {
    return {
      status: 'success',
      data: await this.operations.adminGetWebsite(websiteId),
    };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Post(['adstation/admin/websites/:websiteId/policy', 'admin/ads/websites/:websiteId/policy'])
  @ApiOperation({
    summary: 'Admin: Approve, reject, or set testing policy status on a promoter website',
  })
  async reviewWebsitePolicy(
    @Req() req: any,
    @Param('websiteId', new ParseUUIDPipe()) websiteId: string,
    @Body()
    dto: {
      decision: 'approved' | 'rejected' | 'testing' | 'suspended';
      reason?: string;
    },
  ) {
    const result = await this.operations.reviewWebsitePolicy(
      websiteId,
      dto.decision,
      dto.reason,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Get(['adstation/admin/auction-decisions', 'admin/ads/auction-decisions'])
  @ApiOperation({
    summary: 'Admin: List recent tamper-evident auction decision snapshots with pagination and search',
  })
  async listAuctionDecisions(
    @Query('limit') limit?: number,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
    @Query('slotTagId') slotTagId?: string,
    @Query('requestId') requestId?: string,
    @Query('search') search?: string,
    @Query('inventoryClass') inventoryClass?: string,
  ) {
    const decisions = await this.operations.listAuctionDecisions({
      limit,
      page,
      pageSize,
      slotTagId,
      requestId,
      search,
      inventoryClass,
    });
    return { status: 'success', data: decisions };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Get(['adstation/admin/auction-decisions/:requestId', 'admin/ads/auction-decisions/:requestId'])
  @ApiOperation({
    summary: 'Admin: Get single tamper-evident auction decision snapshot by requestId',
  })
  async getAuctionDecision(@Param('requestId') requestId: string) {
    const decision = await this.operations.getAuctionDecision(requestId);
    return { status: 'success', data: decision };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Post(['adstation/admin/slots/:id/check-installation', 'admin/ads/slots/:id/check-installation'])
  @ApiOperation({
    summary: 'Admin: Verify slot installation evidence on promoter website',
  })
  async adminCheckSlotInstallation(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.operations.adminCheckSlotInstallation(id);
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Post(['adstation/admin/slots/:id/lifecycle', 'admin/ads/slots/:id/lifecycle'])
  @ApiOperation({
    summary: 'Admin: Transition slot lifecycle status with validation and audit trail',
  })
  async adminUpdateSlotLifecycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('targetLifecycle') targetLifecycle: 'active' | 'testing' | 'paused' | 'suspended',
    @Body('reason') reason: string,
    @Req() req: any,
  ) {
    const result = await this.operations.adminUpdateSlotLifecycle(
      id,
      targetLifecycle,
      reason,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }
}

documentAdsController(AdsOperationsController);
