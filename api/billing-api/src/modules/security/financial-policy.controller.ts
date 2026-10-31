import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FINANCIAL_SECURITY_POLICY } from '@crimfig/shared';
import { BillingStaffGrants } from './billing-staff-grants';

@ApiTags('Financial security')
@Controller('admin/security')
export class FinancialPolicyController {
  constructor(private readonly grants: BillingStaffGrants) {}
  @Get('policy')
  @ApiOperation({ summary: 'Read source-controlled withdrawal limits; platform admins only; no execution activation' })
  policy(@Req() req: { user?: { sub?: string } }) {
    const actor = req.user?.sub;
    // BillingAccessGuard independently checks authenticated active account status before this handler.
    if (!actor || !this.grants.rolesFor(actor).includes('super_admin')) throw new ForbiddenException('Platform administrator access required');
    return { status: 'success', data: { ...FINANCIAL_SECURITY_POLICY, mode: 'not_activated',
      reviewers: { standard: 1, elevated: 2, policyRelaxation: 2 },
      note: 'Configured pilot limits. Independent withdrawal execution has not been activated.' } };
  }
}
