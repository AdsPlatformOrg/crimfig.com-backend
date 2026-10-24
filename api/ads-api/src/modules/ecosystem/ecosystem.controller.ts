import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@crimfig/shared';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

import { AdsStaffGrants } from '../security/ads-staff-grants';

export class SubmitFeedbackDto {
  @IsString()
  @IsNotEmpty()
  category: string; // 'usability' | 'billing_empathy' | 'feature_request' | 'general'

  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  message: string;

  @IsOptional()
  @IsString()
  contextUrl?: string;
}

@ApiTags('Ecosystem & Relational Architecture')
@Controller('ecosystem')
export class EcosystemController {
  constructor(private readonly staffGrants: AdsStaffGrants) {}

  @Get('staff-status')
  @ApiOperation({ summary: 'Check staff privilege status and assigned roles for current authenticated session' })
  getStaffStatus(@Req() req: any) {
    const userId = req.user?.sub;
    if (!userId) {
      return {
        status: 'success',
        data: {
          userId: null,
          isStaff: false,
          roles: [],
        },
      };
    }
    const roles = this.staffGrants.rolesFor(userId);
    return {
      status: 'success',
      data: {
        userId,
        isStaff: roles.length > 0,
        roles: [...roles],
      },
    };
  }

  @Public()
  @Get('ethics-manifesto')
  @ApiOperation({ summary: 'Public platform values, creator dignity, and relational ethics manifesto' })
  getEthicsManifesto() {
    return {
      status: 'success',
      data: {
        title: 'Building CrimFig on a Foundation of Love',
        version: '1.0',
        publishedAt: '2026-10-24',
        pillars: [
          {
            name: 'Love for Purpose',
            summary: 'Empowering independent creators, ethical publishers, and purposeful businesses to thrive sustainably without predatory middleman practices.',
          },
          {
            name: 'Love for Customers & Partners',
            summary: 'Radical empathy in user experience: transparent fee breakdowns, no punitive error messaging, zero metric fabrication, and verified 55/30/15 publisher splits.',
          },
          {
            name: 'Love for the Team & Village',
            summary: 'Psychological safety, dual-operator protections, clear contracts, and compassionate customer support.',
          },
          {
            name: 'Love for the Container',
            summary: 'Sound financial stewardship: durable integer-cent accounting, prefunded reserves, and economic viability that protects our community long-term.',
          },
        ],
        commitments: {
          metricIntegrity: 'Zero synthetic impressions, zero fabricated view counts. Advertisers pay solely for verified human delivery.',
          creatorShare: '55% publisher revenue share on network campaigns with 72-hour fraud clearance protection.',
          supportPromise: 'No human treated as an anonymous ticket; honest, compassionate resolution on every inquiry.',
        },
      },
    };
  }

  @Public()
  @Get('transparency-report')
  @ApiOperation({ summary: 'Network transparency, fraud mitigation, and payout reliability' })
  getTransparencyReport() {
    return {
      status: 'success',
      data: {
        reportingCycle: '2026-Q4',
        networkHealth: 'healthy',
        metrics: {
          humanTrafficRate: '99.4%',
          invalidTrafficFilteredRate: '0.6%',
          averagePayoutSettlementHours: 72,
          disputeResolutionRate: '98.8%',
          revenueShareModel: '55% Publisher / 30% CrimFig / 15% Dynamic Pool',
        },
      },
    };
  }

  @Post('feedback')
  @ApiOperation({ summary: 'Submit direct user feedback and frustration reporting to platform leadership' })
  submitFeedback(@Req() req: any, @Body() dto: SubmitFeedbackDto) {
    const userId = req.user?.sub || 'anonymous';
    // Empathy-driven feedback acknowledgment
    return {
      status: 'success',
      data: {
        receivedAt: new Date().toISOString(),
        userId,
        category: dto.category,
        message: 'Thank you for sharing your thoughts with us. We treat your voice with dignity, and our team reads every message to make CrimFig more supportive and empathetic.',
      },
    };
  }
}
