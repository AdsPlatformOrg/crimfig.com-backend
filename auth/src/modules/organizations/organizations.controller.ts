import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrganizationsService, CreateOrgDto, InviteMemberDto } from './organizations.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';

@ApiTags('Organizations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(private readonly orgsService: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new organization' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrgDto) {
    return this.orgsService.createOrg(user.sub, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "List the current user's organizations" })
  getMyOrgs(@CurrentUser() user: JwtPayload) {
    return this.orgsService.getUserOrgs(user.sub);
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members of an organization' })
  getMembers(@Param('orgId') orgId: string) {
    return this.orgsService.getOrgMembers(orgId);
  }

  @Post(':orgId/members')
  @ApiOperation({ summary: 'Invite a user to an organization' })
  invite(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.orgsService.inviteMember(orgId, user.sub, dto);
  }
}
