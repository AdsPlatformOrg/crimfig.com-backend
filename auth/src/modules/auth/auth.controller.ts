import {
  Controller, Post, Get, Body, Query, Req, Res, HttpCode, HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, ForgotPasswordDto, ResetPasswordDto } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';

@ApiTags('Auth')
@UseGuards(ThrottlerGuard)
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Registration & Login ─────────────────────────────────────────────────

  @Post('signup')
  @ApiOperation({ summary: 'Create a new individual account' })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email & password' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fingerprint = req.headers['x-device-fingerprint'] as string | undefined;
    const result = await this.authService.login(dto, fingerprint);

    if (!result.requiresMfa && 'refreshToken' in result) {
      res.cookie('crimfig_rt', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });
    }

    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  async logout(@CurrentUser() user: JwtPayload, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rt = req.cookies?.crimfig_rt;
    res.clearCookie('crimfig_rt', { path: '/api/v1/auth' });
    return this.authService.logout(user.sub, rt);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  getMe(@CurrentUser() user: JwtPayload) {
    return { userId: user.sub, email: user.email };
  }

  // ── Email Verification ───────────────────────────────────────────────────

  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address from link in email' })
  verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend email verification link' })
  resendVerification(@CurrentUser() user: JwtPayload) {
    return this.authService.resendVerification(user.sub, user.email);
  }

  // ── Password Reset ───────────────────────────────────────────────────────

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset email' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
