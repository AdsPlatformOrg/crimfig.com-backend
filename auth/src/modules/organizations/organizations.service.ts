import { Injectable, Inject, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { IsString, IsNotEmpty, IsOptional, IsEnum, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class CreateOrgDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'acme-corp' })
  @IsString() @IsNotEmpty() @MaxLength(100)
  @MinLength(3)
  slug: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'NG', default: 'NG' })
  @IsOptional() @IsString()
  country?: string;
}

export class InviteMemberDto {
  @ApiProperty() @IsString() @IsNotEmpty() userId: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'], default: 'MEMBER' })
  @IsEnum(['OWNER', 'ADMIN', 'MEMBER'])
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async createOrg(userId: string, dto: CreateOrgDto) {
    // Check slug uniqueness
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
        ownerQuorumCount: 2, // enforce 2-owner minimum
        status: 'ACTIVE',
      })
      .returning();

    // Make the creator the first OWNER
    await this.db.insert(schema.organizationMembers).values({
      organizationId: org.id,
      userId,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });

    return org;
  }

  async getUserOrgs(userId: string) {
    return this.db.query.organizationMembers.findMany({
      where: and(
        eq(schema.organizationMembers.userId, userId),
        eq(schema.organizationMembers.status, 'ACTIVE'),
      ),
      with: { organizationId: true } as any,
    });
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

    // Only OWNERs can invite other OWNERs
    if (dto.role === 'OWNER' && inviter.role !== 'OWNER') {
      throw new ForbiddenException('Only Owners can grant Owner role');
    }

    const [member] = await this.db
      .insert(schema.organizationMembers)
      .values({
        organizationId: orgId,
        userId: dto.userId,
        role: dto.role,
        status: 'INVITED',
        invitedByUserId: inviterUserId,
      })
      .returning();

    // TODO: Send invitation email (Phase 1b)
    return member;
  }

  async getOrgMembers(orgId: string) {
    return this.db.query.organizationMembers.findMany({
      where: and(
        eq(schema.organizationMembers.organizationId, orgId),
        isNull(schema.organizationMembers.revokedAt ?? undefined),
      ),
    });
  }
}
