import { Controller, Get, Post, Query, Body, UseGuards, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { OAuthService, AuthorizeDto } from './oauth.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { JwtPayload } from '../tokens/tokens.service';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class TokenExchangeDto {
  @ApiProperty() @IsString() @IsNotEmpty() grant_type!: string;
  @ApiProperty() @IsString() @IsNotEmpty() client_id!: string;
  @ApiProperty() @IsString() @IsNotEmpty() redirect_uri!: string;
  @ApiProperty() @IsString() @IsNotEmpty() code!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() code_verifier?: string;
}

@ApiTags('OAuth 2.0 / OIDC')
@Controller({ path: 'oauth', version: '1' })
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  /**
   * Step 1: Validate client and redirect to login UI.
   * The frontend auth app calls this to start the OAuth flow.
   */
  @Get('authorize')
  @ApiOperation({ summary: 'OAuth2 authorization endpoint — validates client & redirects to login' })
  async authorize(@Query() dto: AuthorizeDto, @Res() res: Response) {
    await this.oauthService.validateClient(dto.client_id, dto.redirect_uri);
    // Redirect to the login page, passing OAuth params as query string
    const params = new URLSearchParams({
      client_id: dto.client_id,
      redirect_uri: dto.redirect_uri,
      response_type: dto.response_type,
      ...(dto.scope && { scope: dto.scope }),
      ...(dto.state && { state: dto.state }),
      ...(dto.code_challenge && { code_challenge: dto.code_challenge }),
      ...(dto.code_challenge_method && { code_challenge_method: dto.code_challenge_method }),
    });
    return res.redirect(`${process.env.AUTH_WEB_URL}/login?${params.toString()}`);
  }

  /**
   * Step 2: After user logs in, the frontend POSTs here to get an auth code.
   * This is the "approve" action — user is already authenticated via JwtAuthGuard.
   */
  @Post('authorize/approve')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue authorization code for authenticated user' })
  async approveAuthorization(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AuthorizeDto,
  ) {
    await this.oauthService.validateClient(dto.client_id, dto.redirect_uri);
    const code = await this.oauthService.generateAuthCode(user.sub, dto.client_id, dto.redirect_uri, dto.code_challenge);
    return { code, state: dto.state };
  }

  /**
   * Step 3: Client exchanges auth code for access + refresh tokens.
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange authorization code for access & refresh tokens' })
  async token(@Body() dto: TokenExchangeDto) {
    if (dto.grant_type !== 'authorization_code') {
      return { error: 'unsupported_grant_type' };
    }
    return this.oauthService.exchangeCodeForTokens(dto.code, dto.client_id, dto.redirect_uri, dto.code_verifier);
  }

  /**
   * OIDC UserInfo endpoint — returns claims about the authenticated user.
   */
  @Get('userinfo')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OIDC userinfo endpoint' })
  userInfo(@CurrentUser() user: JwtPayload) {
    return this.oauthService.getUserInfo(user.sub);
  }
}
