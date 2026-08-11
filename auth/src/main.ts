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

const logger = new Logger('Bootstrap');

async function bootstrap() {
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
  app.use(helmet());
  const cookieParserFn = (cookieParser as any).default || cookieParser;
  app.use(cookieParserFn());

  // ─── CORS ─────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: config.APP.ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
