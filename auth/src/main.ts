import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger, ShutdownSignal } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config/config';

import { runMigrations } from '@crimfig/database';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  // Ensure database tables and migrations are up to date on every boot/deployment
  try {
    logger.log('Checking and running database migrations for crimfig_core...');
    await runMigrations();
    logger.log('Database migrations completed successfully');
  } catch (migErr) {
    logger.error('Failed to run database migrations during bootstrap', migErr);
    // Continue or throw depending on environment; throw to avoid starting on corrupt/empty DB
    throw migErr;
  }

  const app = await NestFactory.create(AppModule, {
    logger: config.IS_PRODUCTION ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // ─── Graceful Shutdown ─────────────────────────────────────────────────────
  // Enables NestJS lifecycle hooks (OnModuleDestroy) so Redis, DB pools, and
  // NATS connections are cleanly closed before the process exits.
  // Critical for zero-downtime rolling deployments — in-flight requests finish,
  // new requests are rejected, then the process exits cleanly.
  app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);

  // ─── Security Middleware ───────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'unsafe-none' },
    }),
  );
  const cookieParserFn = (cookieParser as any).default || cookieParser;
  app.use(cookieParserFn());

  // ─── CORS ─────────────────────────────────────────────────────────────────
  const staticAllowedOrigins = new Set(
    config.APP.ALLOWED_ORIGINS.map((o) => o.toLowerCase().replace(/\/$/, '')),
  );

  app.enableCors({
    origin: (requestOrigin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!requestOrigin) {
        return callback(null, true);
      }

      const normalized = requestOrigin.toLowerCase().replace(/\/$/, '');

      // Check configured static list
      if (staticAllowedOrigins.has(normalized)) {
        return callback(null, true);
      }

      // Allow any *.crimfig.com subdomain (auth, ads, billing, etc.)
      if (/^https?:\/\/(?:[a-z0-9-]+\.)*crimfig\.com(?::\d+)?$/.test(normalized)) {
        return callback(null, true);
      }

      // Allow any *.railway.app domain (Railway deployment / preview URLs)
      if (/^https?:\/\/(?:[a-z0-9-]+\.)*railway\.app(?::\d+)?$/.test(normalized)) {
        return callback(null, true);
      }

      // Allow local development (localhost / 127.0.0.1 on any port)
      if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(normalized)) {
        return callback(null, true);
      }

      logger.warn(`Blocked CORS request from origin: ${requestOrigin}`);
      callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
    ],
    exposedHeaders: ['Set-Cookie'],
  });

  // ─── Global Validation Pipe ───────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ─── API Versioning & Prefix ──────────────────────────────────────────────
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');

  // ─── Swagger (dev + staging only) ─────────────────────────────────────────
  if (!config.IS_PRODUCTION) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CrimFig Auth API')
        .setDescription('OAuth2/OIDC, JWT, MFA, Organization & Consent management')
        .setVersion('1.0')
        .addBearerAuth()
        .addCookieAuth('crimfig_rt')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`📖 Swagger docs: http://localhost:${config.PORT}/api/docs`);
  }

  await app.listen(config.PORT);
  logger.log(`🚀 CrimFig Auth API running — port ${config.PORT} [${config.NODE_ENV}]`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error('Fatal startup error', err);
  process.exit(1);
});
