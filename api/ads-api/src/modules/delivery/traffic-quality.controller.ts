import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CrimfigAuthGuard } from '@crimfig/shared';
import { AdsAccessGuard } from '../security/ads-access.guard';
import { AdsRoles } from '../security/ads-staff-grants';

@Controller()
@UseGuards(CrimfigAuthGuard)
export class TrafficQualityController {
  constructor(@Inject('DATABASE_CONNECTION') private readonly db: any) {}

  @Get('admin/ads/traffic-quality/publishers')
  @UseGuards(AdsAccessGuard)
  @AdsRoles('ads_admin', 'super_admin', 'ads_finance')
  async listPublishers() {
    const result = await this.db.execute(
      `SELECT a.id, a.promoter_id, a.website_id, a.window_start, a.window_end,
              a.visitor_count, a.distinct_ip_count, a.click_count, a.click_to_visit_ratio,
              a.high_signals, a.supporting_signals, a.model_version, a.enforcement_mode,
              a.disposition, a.would_quarantine_if_enforced, a.created_at
       FROM ads_publisher_traffic_assessments a
       ORDER BY a.created_at DESC
       LIMIT 100`,
    );
    return { status: 'success', data: result.rows ?? result };
  }

  @Get('admin/ads/traffic-quality/publishers/:promoterId')
  @UseGuards(AdsAccessGuard)
  @AdsRoles('ads_admin', 'super_admin', 'ads_finance')
  async getPublisherDetail(@Param('promoterId') promoterId: string) {
    const assessments = await this.db.execute(
      `SELECT * FROM ads_publisher_traffic_assessments WHERE promoter_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [promoterId],
    );
    const cohorts = await this.db.execute(
      `SELECT * FROM ads_click_quarantine_cohorts WHERE promoter_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [promoterId],
    );
    return {
      status: 'success',
      data: {
        assessments: assessments.rows ?? assessments,
        cohorts: cohorts.rows ?? cohorts,
      },
    };
  }

  @Post('admin/ads/traffic-quality/quarantine/:cohortId/resolve')
  @UseGuards(AdsAccessGuard)
  @AdsRoles('ads_admin', 'super_admin')
  async resolveQuarantine(
    @Param('cohortId') cohortId: string,
    @Body() body: { decision?: 'approved' | 'rejected'; note?: string },
    @Req() req: any,
  ) {
    if (body?.decision !== 'approved' && body?.decision !== 'rejected') {
      throw new BadRequestException('Decision must be approved or rejected');
    }
    const reviewerId = req.user?.id;
    const updated = await this.db.execute(
      `UPDATE ads_click_quarantine_cohorts
       SET status = $1, resolved_by = $2, resolution_note = $3, resolved_at = now()
       WHERE id = $4 AND status = 'pending_review'
       RETURNING *`,
      [body.decision, reviewerId ?? null, (body.note ?? '').slice(0, 1000), cohortId],
    );
    const rows = updated.rows ?? updated;
    if (!rows.length) {
      throw new NotFoundException('Pending quarantine cohort not found');
    }
    return { status: 'success', data: rows[0] };
  }

  @Post('promoter/traffic-quality/appeals')
  async createAppeal(
    @Body() body: { promoterId?: string; websiteId?: string; cohortId?: string; explanation?: string },
    @Req() req: any,
  ) {
    const explanation = typeof body?.explanation === 'string' ? body.explanation.trim() : '';
    if (explanation.length < 10 || explanation.length > 2000) {
      throw new BadRequestException('Appeal explanation must be between 10 and 2000 characters');
    }
    if (!body?.promoterId) {
      throw new BadRequestException('promoterId is required');
    }
    const owner = await this.db.execute(
      `SELECT id FROM ads_promoters WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [body.promoterId, req.user?.id],
    );
    if (!(owner.rows ?? owner).length) {
      throw new ForbiddenException('You do not own this promoter profile');
    }
    const inserted = await this.db.execute(
      `INSERT INTO ads_publisher_traffic_appeals (promoter_id, website_id, cohort_id, explanation)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [body.promoterId, body.websiteId ?? null, body.cohortId ?? null, explanation],
    );
    return { status: 'success', data: (inserted.rows ?? inserted)[0] };
  }

  @Patch('admin/ads/traffic-quality/appeals/:appealId')
  @UseGuards(AdsAccessGuard)
  @AdsRoles('ads_admin', 'super_admin')
  async resolveAppeal(
    @Param('appealId') appealId: string,
    @Body() body: { status?: 'upheld' | 'denied'; reviewNote?: string },
    @Req() req: any,
  ) {
    if (body?.status !== 'upheld' && body?.status !== 'denied') {
      throw new BadRequestException('Appeal status must be upheld or denied');
    }
    const updated = await this.db.execute(
      `UPDATE ads_publisher_traffic_appeals
       SET status = $1, reviewed_by = $2, review_note = $3, reviewed_at = now()
       WHERE id = $4
       RETURNING *`,
      [body.status, req.user?.id ?? null, (body.reviewNote ?? '').slice(0, 1000), appealId],
    );
    const rows = updated.rows ?? updated;
    if (!rows.length) {
      throw new NotFoundException('Appeal not found');
    }
    return { status: 'success', data: rows[0] };
  }
}

