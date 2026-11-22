import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { AuthRoles } from '../../security/auth-staff-grants';
import { AuthStaffRoleGuard } from '../../security/auth-staff-role.guard';
import { EmailService } from './email.service';

@ApiTags('Platform Admin')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtAuthGuard, AuthStaffRoleGuard)
@AuthRoles('super_admin')
@Controller({ path: 'admin/email-templates', version: '1' })
export class EmailTemplatesController {
  constructor(private readonly emailService: EmailService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Preview CrimFig email templates with sample data' })
  list() {
    return { status: 'success', data: this.emailService.listTemplatePreviews() };
  }
}
