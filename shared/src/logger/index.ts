import { Injectable, LoggerService, Scope } from '@nestjs/common';

// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — Structured JSON Logger
//
// Wraps NestJS LoggerService with structured JSON output suitable for
// Railway log drain, Datadog, and Elastic Stack ingestion.
//
// Every log line emits:
//   { level, timestamp, service, context, message, ...meta }
//
// Usage:
//   import { CrimfigLogger } from '@crimfig/shared';
//
//   @Injectable()
//   export class MyService {
//     private readonly logger = new CrimfigLogger(MyService.name, 'my-service');
//
//     doSomething() {
//       this.logger.log('User registered', { userId: user.id, email: user.email });
//       this.logger.audit('AUTH_LOGIN_SUCCESS', { userId, ip, appClientId });
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'audit';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  service: string;
  context: string;
  message: string;
  [key: string]: unknown;
}

@Injectable({ scope: Scope.TRANSIENT })
export class CrimfigLogger implements LoggerService {
  constructor(
    /** NestJS context label (usually the class name) */
    private readonly context: string = 'App',
    /** Service name — appears in every log line for log drain routing */
    private readonly service: string = 'unknown',
  ) {}

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
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
    } else {
      const color = {
        debug: '\x1b[36m', // cyan
        info: '\x1b[32m',  // green
        warn: '\x1b[33m',  // yellow
        error: '\x1b[31m', // red
        audit: '\x1b[35m', // magenta
      }[level];
      const reset = '\x1b[0m';
      const prefix = `${color}[${level.toUpperCase()}]${reset} [${entry.service}/${entry.context}]`;
      console.log(`${prefix} ${message}`, meta ?? '');
    }
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.emit('info', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env['NODE_ENV'] !== 'production') {
      this.emit('debug', message, meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit('warn', message, meta);
  }

  error(message: string, trace?: string, meta?: Record<string, unknown>): void {
    this.emit('error', message, { stack: trace, ...meta });
  }

  /**
   * Emit a structured AUDIT log line.
   * These are forwarded to the `audit-api` microservice via NATS.
   *
   * @param action - Machine-readable action code e.g. 'AUTH_LOGIN_SUCCESS', 'ORG_MEMBER_REMOVED'
   * @param meta   - Contextual fields: userId, organizationId, ip, appClientId, etc.
   */
  audit(action: string, meta: Record<string, unknown>): void {
    this.emit('audit', action, { audit: true, ...meta });
  }

  /** NestJS LoggerService compat — called by framework internals */
  verbose(message: string): void {
    this.debug(message);
  }

  /** Create a child logger with the same service name but a different context */
  forContext(context: string): CrimfigLogger {
    return new CrimfigLogger(context, this.service);
  }
}
