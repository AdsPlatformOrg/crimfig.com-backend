import {
  Body, Controller, ForbiddenException, Headers, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IsIn, IsString, Matches } from 'class-validator';
import { EmailService } from '../email/email.service';
import { verifyReleaseAlertIdentity } from './release-alert-identity';
import policy from '../../../../shared/src/config/release-alerts.json';

const subjects = {
  failure: 'CrimFig staging release check failed',
  test: 'CrimFig release alert delivery test',
  'production-success': 'CrimFig production ad delivery check passed',
  'production-failure': 'CrimFig production ad delivery check failed',
};

class ReleaseAlertDto {
  @IsString() @Matches(/^[0-9]{1,25}$/) runId!: string;
  @IsString() @Matches(/^[0-9a-f]{40}$/) revision!: string;
  @IsIn(Object.keys(subjects)) kind!: keyof typeof subjects;
}

@Controller('health')
@UseGuards(ThrottlerGuard)
export class ReleaseAlertController {
  private readonly delivered = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly email: EmailService) {}

  @Post('release-alert')
  async notify(@Headers('authorization') authorization: string | undefined, @Body() input: ReleaseAlertDto) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const claims = await verifyReleaseAlertIdentity(token, input.runId);
    const productionStatus = input.kind.startsWith('production-');
    if (productionStatus !== (claims.ref === 'refs/heads/production')) throw new ForbiddenException();
    if (claims.sha !== input.revision) throw new ServiceUnavailableException('Release alert revision differs');
    if (this.delivered.has(input.runId)) return { accepted: true, replayed: true };
    if (this.inFlight.has(input.runId)) throw new ServiceUnavailableException('Release notification is in progress');
    this.inFlight.add(input.runId);
    try {
      const runUrl = 'https://github.com/' + policy.repository + '/actions/runs/' + input.runId;
      const subject = subjects[input.kind];
      const text = subject + '\nRevision ' + input.revision + '\nReview the GitHub Actions run\n' + runUrl;
      const result = await this.email.sendErrorAlertEmail({
        recipients: policy.ADMIN_ALERTS_EMAIL, subject,
        htmlContent: '<p>' + subject + '</p><p>Revision ' + input.revision + '</p><p><a href="' + runUrl + '">Review GitHub Actions</a></p>',
        textContent: text,
      });
      if (!result.accepted) throw new ServiceUnavailableException('Release email was not accepted');
      this.delivered.set(input.runId, Date.now());
      if (this.delivered.size > 1000) this.delivered.delete(this.delivered.keys().next().value!);
      return { accepted: true, providerMessageId: result.providerMessageId };
    } finally { this.inFlight.delete(input.runId); }
  }
}
