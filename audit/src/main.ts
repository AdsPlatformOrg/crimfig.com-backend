import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger, ShutdownSignal } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Graceful shutdown hooks (SIGINT / SIGTERM) for zero-downtime deploy
  app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);

  // Security Middleware
  app.use(helmet());

  // CORS
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Versioning & Prefix
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');

  // Swagger Documentation
  if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CrimFig Audit API')
        .setDescription('Centralized Audit & Compliance Event Logging Microservice')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`📖 Audit Swagger docs: http://localhost:${process.env.PORT || 3002}/api/docs`);
  }

  const port = process.env.PORT || 3002;
  await app.listen(port);
  logger.log(`🚀 CrimFig Audit API running on port ${port}`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error('Fatal startup error', err);
  process.exit(1);
});
