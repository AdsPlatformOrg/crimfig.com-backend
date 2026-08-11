import type { JwtPayload } from '../types';
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
export declare const CurrentUser: (...dataOrPipes: (import("@nestjs/common").PipeTransform<any, any> | keyof JwtPayload | import("@nestjs/common").Type<import("@nestjs/common").PipeTransform<any, any>> | undefined)[]) => ParameterDecorator;
export declare const IS_PUBLIC_KEY = "crimfig_is_public";
/**
 * Marks a route as publicly accessible, bypassing CrimfigAuthGuard.
 * Use sparingly — health checks, OAuth callback endpoints, public content feeds.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   healthCheck() { ... }
 */
export declare const Public: () => import("@nestjs/common").CustomDecorator<string>;
export declare const API_VERSION_KEY = "crimfig_api_version";
/**
 * Documents the API version a controller or handler was introduced in.
 * Used for changelog tracking and deprecation warnings — not for routing.
 *
 * Usage:
 *   @ApiVersion('2026-08')
 *   @Controller('users')
 *   export class UsersController { ... }
 */
export declare const ApiVersion: (version: string) => import("@nestjs/common").CustomDecorator<string>;
//# sourceMappingURL=index.d.ts.map