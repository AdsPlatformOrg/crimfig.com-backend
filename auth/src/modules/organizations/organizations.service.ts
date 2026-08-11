import {
  Injectable, Inject, BadRequestException, ForbiddenException,
  NotFoundException, ConflictException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { config } from '../../config/config';
import { CrimfigLogger } from '@crimfig/shared';
import {
  IsString, IsNotEmpty, IsOptional, IsEnum, MinLength, MaxLength, IsEmail,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class CreateOrgDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString() @IsNotEmpty() @MaxLength(255)
  name!: string;

  @ApiProperty({ example: 'acme-corp' })
  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(100)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'NG', default: 'NG' })
  @IsOptional() @IsString()
  country?: string;
}

export class InviteMemberDto {
  @ApiProperty({ description: 'Email address of the user to invite' })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'], default: 'MEMBER' })
  @IsEnum(['OWNER', 'ADMIN', 'MEMBER'])
  role!: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export class AcceptInviteDto {
  @ApiProperty({ description: 'Invite token received by email' })
  @IsString() @IsNotEmpty()
  token!: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class OrganizationsService {
  private readonly logger = new CrimfigLogger(OrganizationsService.name, 'auth-api');

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly emailService: EmailService,
    private readonly jwtService: JwtService,
  ) {}

  async createOrg(userId: string, dto: CreateOrgDto) {
    const existing = await this.db.query.organizations.findFirst({
      where: eq(schema.organizations.slug, dto.slug),
    });
    if (existing) throw new BadRequestException('Organisation slug already taken');

    const [org] = await this.db
      .insert(schema.organizations)
      .values({
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        country: dto.country ?? 'NG',
        ownerQuorumCount: 2,
        status: 'ACTIVE',
      })
      .returning();

    await this.db.insert(schema.organizationMembers).values({
      organizationId: org.id,
      userId,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });

    this.logger.audit('ORG_CREATED', { userId, orgId: org.id, slug: dto.slug });
    return org;
  }

  async getUserOrgs(userId: string) {
    const memberships = await this.db.query.organizationMembers.findMany({
      where: and(
        eq(schema.organizationMembers.userId, userId),
        eq(schema.organizationMembers.status, 'ACTIVE'),
      ),
    });
    return memberships;
  }

  async inviteMember(orgId: string, inviterUserId: string, dto: InviteMemberDto) {
    // Inviter must be OWNER or ADMIN
    const inviter = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(schema.organizationMembers.organizationId, orgId),
        eq(schema.organizationMembers.userId, inviterUserId),
        eq(schema.organizationMembers.status, 'ACTIVE'),
      ),
    });
    if (!inviter || !['OWNER', 'ADMIN'].includes(inviter.role)) {
      throw new ForbiddenException('Only Owners or Admins can invite members');
    }
    if (dto.role === 'OWNER' && inviter.role !== 'OWNER') {
      throw new ForbiddenException('Only Owners can grant Owner role');
    }

    // Look up the org
    const org = await this.db.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgId),
    });
    if (!org) throw new NotFoundException('Organisation not found');

    // Look up invitee by email
    const invitee = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    // Check for existing active membership
    if (invitee) {
      const existing = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(schema.organizationMembers.organizationId, orgId),
          eq(schema.organizationMembers.userId, invitee.id),
        ),
      });
      if (existing && existing.status !== 'SUSPENDED') {
        throw new ConflictException('User is already a member of this organisation');
      }
    }

    // Get inviter user details for email
    const inviterUser = await this.db.query.users.findFirst({
      where: eq(schema.users.id, inviterUserId),
      columns: { email: true },
    });

    // Generate invite token (JWT, 7 days expiry)
    const inviteToken = this.jwtService.sign(
      { orgId, email: dto.email, role: dto.role, purpose: 'org_invite' },
      { secret: config.JWT.ACCESS_SECRET, expiresIn: '7d' },
    );

    // Insert INVITED member record (userId may be null if not yet registered)
    const [member] = await this.db
      .insert(schema.organizationMembers)
      .values({
        organizationId: orgId,
        userId: invitee?.id ?? inviterUserId, // placeholder until they accept
        role: dto.role,
        status: 'INVITED',
        invitedByUserId: inviterUserId,
      })
      .returning();

    // Send invitation email
    await this.emailService.sendOrgInviteEmail({
      to: { email: dto.email },
      orgName: org.name,
      inviterName: inviterUser?.email ?? 'A team member',
      role: dto.role,
      inviteToken,
    });

    this.logger.audit('ORG_MEMBER_INVITED', {
      orgId, inviterUserId, inviteeEmail: dto.email, role: dto.role,
    });
    return { message: 'Invitation sent', memberId: member.id };
  }

  async acceptInvite(userId: string, dto: AcceptInviteDto) {
    let payload: { orgId: string; email: string; role: string; purpose: string };
    try {
      payload = this.jwtService.verify(dto.token, { secret: config.JWT.ACCESS_SECRET });
    } catch {
      throw new BadRequestException('Invalid or expired invite token');
    }
    if (payload.purpose !== 'org_invite') throw new BadRequestException('Invalid token');

    // Activate the INVITED membership for this user
    const existing = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(schema.organizationMembers.organizationId, payload.orgId),
        eq(schema.organizationMembers.status, 'INVITED'),
      ),
    });
    if (!existing) throw new BadRequestException('Invite not found or already accepted');

    await this.db.update(schema.organizationMembers)
      .set({ userId, status: 'ACTIVE', joinedAt: new Date() })
      .where(eq(schema.organizationMembers.id, existing.id));

    this.logger.audit('ORG_INVITE_ACCEPTED', { userId, orgId: payload.orgId });
    return { message: 'You have joined the organisation successfully' };
  }

  async getOrgMembers(orgId: string) {
    return this.db.query.organizationMembers.findMany({
      where: eq(schema.organizationMembers.organizationId, orgId),
    });
  }

  async removeMember(orgId: string, removerId: string, targetUserId: string) {
    // Remover must be OWNER
    const remover = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(schema.organizationMembers.organizationId, orgId),
        eq(schema.organizationMembers.userId, removerId),
        eq(schema.organizationMembers.status, 'ACTIVE'),
      ),
    });
    if (!remover || remover.role !== 'OWNER') {
      throw new ForbiddenException('Only Owners can remove members');
    }
    if (removerId === targetUserId) {
      throw new BadRequestException('Cannot remove yourself. Transfer ownership first.');
    }

    await this.db.update(schema.organizationMembers)
      .set({ status: 'LEFT' })
      .where(and(
        eq(schema.organizationMembers.organizationId, orgId),
        eq(schema.organizationMembers.userId, targetUserId),
      ));

    this.logger.audit('ORG_MEMBER_REMOVED', { orgId, removerId, targetUserId });
    return { message: 'Member removed from organisation' };
  }
}
