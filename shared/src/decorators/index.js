"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiVersion = exports.API_VERSION_KEY = exports.Public = exports.IS_PUBLIC_KEY = exports.CurrentUser = void 0;
const common_1 = require("@nestjs/common");
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
exports.CurrentUser = (0, common_1.createParamDecorator)((field, ctx) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return field ? user?.[field] : user;
});
// ── @Public() ────────────────────────────────────────────────────────────────
exports.IS_PUBLIC_KEY = 'crimfig_is_public';
/**
 * Marks a route as publicly accessible, bypassing CrimfigAuthGuard.
 * Use sparingly — health checks, OAuth callback endpoints, public content feeds.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   healthCheck() { ... }
 */
const Public = () => (0, common_1.SetMetadata)(exports.IS_PUBLIC_KEY, true);
exports.Public = Public;
// ── @ApiVersion() ─────────────────────────────────────────────────────────────
exports.API_VERSION_KEY = 'crimfig_api_version';
/**
 * Documents the API version a controller or handler was introduced in.
 * Used for changelog tracking and deprecation warnings — not for routing.
 *
 * Usage:
 *   @ApiVersion('2026-08')
 *   @Controller('users')
 *   export class UsersController { ... }
 */
const ApiVersion = (version) => (0, common_1.SetMetadata)(exports.API_VERSION_KEY, version);
exports.ApiVersion = ApiVersion;
//# sourceMappingURL=index.js.map