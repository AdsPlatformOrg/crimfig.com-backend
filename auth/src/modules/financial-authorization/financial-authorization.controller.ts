import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsObject, IsString, Matches } from 'class-validator';
import { ChallengeProposal } from '@crimfig/shared';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { FinancialAuthorizationService } from './financial-authorization.service';
class RegisterFinancialChallengeDto { @IsObject() proposal!: ChallengeProposal; }
class ConfirmFinancialChallengeDto { @IsString() @Matches(/^\d{6}$/) code!: string; }
@Controller({ path: 'financial-authorizations', version: '1' })
@UseGuards(JwtAuthGuard)
export class FinancialAuthorizationController {
  constructor(private readonly service: FinancialAuthorizationService) {}
  @Post('withdrawals/:reference/challenges')
  async begin(@CurrentUser() user: { sub: string }, @Param('reference') reference: string) {
    return { status: 'success', data: await this.service.begin(user.sub, reference) };
  }
  @Post('challenges')
  async register(@CurrentUser() user: { sub: string }, @Body() body: RegisterFinancialChallengeDto) {
    return { status: 'success', data: await this.service.register(user.sub, body.proposal) };
  }
  @Post('challenges/:id/confirm')
  async confirm(@CurrentUser() user: { sub: string }, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ConfirmFinancialChallengeDto) {
    return { status: 'success', data: await this.service.confirm(user.sub, id, body.code) };
  }
  @Get('challenges/:id')
  async read(@CurrentUser() user: { sub: string }, @Param('id', new ParseUUIDPipe()) id: string) {
    return { status: 'success', data: await this.service.read(user.sub, id) };
  }
}
