import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../modules/tokens/tokens.service';

/**
 * Extracts the current authenticated user from the request.
 * Only available on routes protected by JwtAuthGuard.
 *
 * Usage:
 *   @Get('me')
 *   @UseGuards(JwtAuthGuard)
 *   getMe(@CurrentUser() user: JwtPayload) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
