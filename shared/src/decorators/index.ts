import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { JwtPayload } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — NestJS Parameter Decorators & Metadata Decorators
// ─────────────────────────────────────────────────────────────────────────────

// ── @CurrentUser() ────────────────────────────────────────────────────────────

/**
 * Extracts the decoded JWT payload from the current request.
 * Only available on routes protected by CrimfigAuthGuard (or JwtAuthGuard).
 *
 * Usage:
 *   @Get('me')
 *   @UseGuards(CrimfigAuthGuard)
 *   getMe(@CurrentUser() user: JwtPayload) {
 *     return { userId: user.sub };
 *   }
 *
 * Use @CurrentUser('sub') to extract a specific field:
 *   getMe(@CurrentUser('sub') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (field: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: JwtPayload = request.user;
    return field ? user?.[field] : user;
  },
);

// ── @Public() ────────────────────────────────────────────────────────────────

export const IS_PUBLIC_KEY = 'crimfig_is_public';

/**
 * Marks a route as publicly accessible, bypassing CrimfigAuthGuard.
 * Use sparingly — health checks, OAuth callback endpoints, public content feeds.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   healthCheck() { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

// ── @ApiVersion() ─────────────────────────────────────────────────────────────

export const API_VERSION_KEY = 'crimfig_api_version';

/**
 * Documents the API version a controller or handler was introduced in.
 * Used for changelog tracking and deprecation warnings — not for routing.
 *
 * Usage:
 *   @ApiVersion('2026-08')
 *   @Controller('users')
 *   export class UsersController { ... }
 */
export const ApiVersion = (version: string) => SetMetadata(API_VERSION_KEY, version);
