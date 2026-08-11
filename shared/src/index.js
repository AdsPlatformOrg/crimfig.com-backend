"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — Public API
//
// All other backend services import from '@crimfig/shared', not from
// individual subpaths. This barrel keeps the public surface clean.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrimfigLogger = exports.API_VERSION_KEY = exports.IS_PUBLIC_KEY = exports.ApiVersion = exports.Public = exports.CurrentUser = exports.REQUIRE_CONSENT_KEY = exports.ROLES_KEY = exports.RequireAppConsent = exports.Roles = exports.AppConsentGuard = exports.RolesGuard = exports.CrimfigAuthGuard = exports.CreateOrganizationDto = exports.PaginationQueryDto = exports.TokenPairResponseDto = exports.MfaChallengeDto = exports.RefreshTokenDto = exports.RegisterDto = exports.LoginDto = void 0;
// DTOs
var dto_1 = require("./dto");
Object.defineProperty(exports, "LoginDto", { enumerable: true, get: function () { return dto_1.LoginDto; } });
Object.defineProperty(exports, "RegisterDto", { enumerable: true, get: function () { return dto_1.RegisterDto; } });
Object.defineProperty(exports, "RefreshTokenDto", { enumerable: true, get: function () { return dto_1.RefreshTokenDto; } });
Object.defineProperty(exports, "MfaChallengeDto", { enumerable: true, get: function () { return dto_1.MfaChallengeDto; } });
Object.defineProperty(exports, "TokenPairResponseDto", { enumerable: true, get: function () { return dto_1.TokenPairResponseDto; } });
Object.defineProperty(exports, "PaginationQueryDto", { enumerable: true, get: function () { return dto_1.PaginationQueryDto; } });
Object.defineProperty(exports, "CreateOrganizationDto", { enumerable: true, get: function () { return dto_1.CreateOrganizationDto; } });
// Guards
var guards_1 = require("./guards");
Object.defineProperty(exports, "CrimfigAuthGuard", { enumerable: true, get: function () { return guards_1.CrimfigAuthGuard; } });
Object.defineProperty(exports, "RolesGuard", { enumerable: true, get: function () { return guards_1.RolesGuard; } });
Object.defineProperty(exports, "AppConsentGuard", { enumerable: true, get: function () { return guards_1.AppConsentGuard; } });
Object.defineProperty(exports, "Roles", { enumerable: true, get: function () { return guards_1.Roles; } });
Object.defineProperty(exports, "RequireAppConsent", { enumerable: true, get: function () { return guards_1.RequireAppConsent; } });
Object.defineProperty(exports, "ROLES_KEY", { enumerable: true, get: function () { return guards_1.ROLES_KEY; } });
Object.defineProperty(exports, "REQUIRE_CONSENT_KEY", { enumerable: true, get: function () { return guards_1.REQUIRE_CONSENT_KEY; } });
// Decorators
var decorators_1 = require("./decorators");
Object.defineProperty(exports, "CurrentUser", { enumerable: true, get: function () { return decorators_1.CurrentUser; } });
Object.defineProperty(exports, "Public", { enumerable: true, get: function () { return decorators_1.Public; } });
Object.defineProperty(exports, "ApiVersion", { enumerable: true, get: function () { return decorators_1.ApiVersion; } });
Object.defineProperty(exports, "IS_PUBLIC_KEY", { enumerable: true, get: function () { return decorators_1.IS_PUBLIC_KEY; } });
Object.defineProperty(exports, "API_VERSION_KEY", { enumerable: true, get: function () { return decorators_1.API_VERSION_KEY; } });
// Logger
var logger_1 = require("./logger");
Object.defineProperty(exports, "CrimfigLogger", { enumerable: true, get: function () { return logger_1.CrimfigLogger; } });
//# sourceMappingURL=index.js.map