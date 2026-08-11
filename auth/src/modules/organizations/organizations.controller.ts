import {
  Controller, Post, Get, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  OrganizationsService, CreateOrgDto, InviteMemberDto, AcceptInviteDto,
} from './organizations.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'orgs', version: '1' })
export class OrganizationsController {
  constructor(private readonly orgService: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new organisation' })
  createOrg(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrgDto) {
    return this.orgService.createOrg(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List organisations the current user belongs to' })
  getMyOrgs(@CurrentUser() user: JwtPayload) {
    return this.orgService.getUserOrgs(user.sub);
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members of an organisation' })
  getMembers(@Param('orgId') orgId: string) {
    return this.orgService.getOrgMembers(orgId);
  }

  @Post(':orgId/members/invite')
  @ApiOperation({ summary: 'Invite a user to join an organisation by email' })
  inviteMember(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.orgService.inviteMember(orgId, user.sub, dto);
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept an organisation invitation using the emailed token' })
  acceptInvite(@CurrentUser() user: JwtPayload, @Body() dto: AcceptInviteDto) {
    return this.orgService.acceptInvite(user.sub, dto);
  }

  @Delete(':orgId/members/:userId')
  @ApiOperation({ summary: 'Remove a member from an organisation (Owner only)' })
  removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.orgService.removeMember(orgId, user.sub, targetUserId);
  }
}
