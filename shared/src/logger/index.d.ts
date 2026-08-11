import { LoggerService } from '@nestjs/common';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'audit';
export interface LogEntry {
    level: LogLevel;
    timestamp: string;
    service: string;
    context: string;
    message: string;
    [key: string]: unknown;
}
export declare class CrimfigLogger implements LoggerService {
    /** NestJS context label (usually the class name) */
    private readonly context;
    /** Service name — appears in every log line for log drain routing */
    private readonly service;
    constructor(
    /** NestJS context label (usually the class name) */
    context?: string, 
    /** Service name — appears in every log line for log drain routing */
    service?: string);
    private emit;
    log(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, trace?: string, meta?: Record<string, unknown>): void;
    /**
     * Emit a structured AUDIT log line.
     * These are forwarded to the `audit-api` microservice via NATS.
     *
     * @param action - Machine-readable action code e.g. 'AUTH_LOGIN_SUCCESS', 'ORG_MEMBER_REMOVED'
     * @param meta   - Contextual fields: userId, organizationId, ip, appClientId, etc.
     */
    audit(action: string, meta: Record<string, unknown>): void;
    /** NestJS LoggerService compat — called by framework internals */
    verbose(message: string): void;
    /** Create a child logger with the same service name but a different context */
    forContext(context: string): CrimfigLogger;
}
//# sourceMappingURL=index.d.ts.map