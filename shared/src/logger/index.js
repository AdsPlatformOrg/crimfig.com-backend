"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CrimfigLogger_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrimfigLogger = void 0;
const common_1 = require("@nestjs/common");
let CrimfigLogger = CrimfigLogger_1 = class CrimfigLogger {
    context;
    service;
    constructor(
    /** NestJS context label (usually the class name) */
    context = 'App', 
    /** Service name — appears in every log line for log drain routing */
    service = 'unknown') {
        this.context = context;
        this.service = service;
    }
    emit(level, message, meta) {
        const entry = {
            level,
            timestamp: new Date().toISOString(),
            service: this.service,
            context: this.context,
            message,
            ...meta,
        };
        // In production, emit clean JSON for log drains.
        // In dev, pretty-print with colors for readability.
        if (process.env['NODE_ENV'] === 'production') {
            process.stdout.write(JSON.stringify(entry) + '\n');
        }
        else {
            const color = {
                debug: '\x1b[36m', // cyan
                info: '\x1b[32m', // green
                warn: '\x1b[33m', // yellow
                error: '\x1b[31m', // red
                audit: '\x1b[35m', // magenta
            }[level];
            const reset = '\x1b[0m';
            const prefix = `${color}[${level.toUpperCase()}]${reset} [${entry.service}/${entry.context}]`;
            console.log(`${prefix} ${message}`, meta ?? '');
        }
    }
    log(message, meta) {
        this.emit('info', message, meta);
    }
    debug(message, meta) {
        if (process.env['NODE_ENV'] !== 'production') {
            this.emit('debug', message, meta);
        }
    }
    warn(message, meta) {
        this.emit('warn', message, meta);
    }
    error(message, trace, meta) {
        this.emit('error', message, { stack: trace, ...meta });
    }
    /**
     * Emit a structured AUDIT log line.
     * These are forwarded to the `audit-api` microservice via NATS.
     *
     * @param action - Machine-readable action code e.g. 'AUTH_LOGIN_SUCCESS', 'ORG_MEMBER_REMOVED'
     * @param meta   - Contextual fields: userId, organizationId, ip, appClientId, etc.
     */
    audit(action, meta) {
        this.emit('audit', action, { audit: true, ...meta });
    }
    /** NestJS LoggerService compat — called by framework internals */
    verbose(message) {
        this.debug(message);
    }
    /** Create a child logger with the same service name but a different context */
    forContext(context) {
        return new CrimfigLogger_1(context, this.service);
    }
};
exports.CrimfigLogger = CrimfigLogger;
exports.CrimfigLogger = CrimfigLogger = CrimfigLogger_1 = __decorate([
    (0, common_1.Injectable)({ scope: common_1.Scope.TRANSIENT }),
    __metadata("design:paramtypes", [String, String])
], CrimfigLogger);
//# sourceMappingURL=index.js.map