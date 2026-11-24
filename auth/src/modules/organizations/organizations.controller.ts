import {
  Controller, Post, Get, Delete, Body, Param, UseGuards, ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  OrganizationsService, CreateOrgDto, InviteMemberDto, AcceptInviteDto,
} from './organizations.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';

const ORGANIZATIONS_ENABLED = false;

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'orgs', version: '1' })
export class OrganizationsController {
  constructor(private readonly orgService: OrganizationsService) {}

  private ensureEnabled(): void {
    if (!ORGANIZATIONS_ENABLED) {
      throw new ServiceUnavailableException('Organizations and team invitations are not enabled yet and are coming soon.');
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a new organisation' })
  createOrg(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrgDto) {
    this.ensureEnabled();
    return this.orgService.createOrg(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List organisations the current user belongs to' })
  getMyOrgs(@CurrentUser() user: JwtPayload) {
    this.ensureEnabled();
    return this.orgService.getUserOrgs(user.sub);
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members of an organisation' })
  getMembers(@Param('orgId') orgId: string) {
    this.ensureEnabled();
    return this.orgService.getOrgMembers(orgId);
  }

  @Post(':orgId/members/invite')
  @ApiOperation({ summary: 'Invite a user to join an organisation by email' })
  inviteMember(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Body() dto: InviteMemberDto,
  ) {
    this.ensureEnabled();
    return this.orgService.inviteMember(orgId, user.sub, dto);
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept an organisation invitation using the emailed token' })
  acceptInvite(@CurrentUser() user: JwtPayload, @Body() dto: AcceptInviteDto) {
    this.ensureEnabled();
    return this.orgService.acceptInvite(user.sub, dto);
  }

  @Delete(':orgId/members/:userId')
  @ApiOperation({ summary: 'Remove a member from an organisation (Owner only)' })
  removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Param('userId') targetUserId: string,
  ) {
    this.ensureEnabled();
    return this.orgService.removeMember(orgId, user.sub, targetUserId);
  }
}
