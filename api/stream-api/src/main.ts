import {
  dashboardOrigins,
  isApiDocsEnabled,
  registerApiWelcomeRoute,
  applyOpenApiAuthRequirements,
} from '@crimfig/shared';
import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Logger, ShutdownSignal } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
  app.use(helmet());

  app.enableCors({
    origin: dashboardOrigins(process.env.NODE_ENV === 'production'),
    credentials: true,
  });

  app.setGlobalPrefix('api');

  const docsEnabled = isApiDocsEnabled(process.env.NODE_ENV === 'production');
  if (docsEnabled) {
    const document = applyOpenApiAuthRequirements(
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('CrimFig Live Stream API')
          .setDescription('WebRTC & RTMP Live Streaming Ingestion Microservice')
          .setVersion('1.0')
          .addBearerAuth()
          .build(),
      ),
      { globalPrefix: 'api', defaultVersion: null, defaultRequireBearerAuth: false },
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  registerApiWelcomeRoute(app, {
    service: 'CrimFig Live Stream API',
    code: 'stream-api',
    description: 'WebRTC & RTMP Live Streaming Ingestion Microservice',
    version: '1.0',
    healthPath: '/api/health',
    docsEnabled,
  });

  const port = process.env.PORT || 3008;
  await app.listen(port);
  logger.log(`🚀 CrimFig Live Stream API running on port ${port}`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error('Fatal startup error', err);
  process.exit(1);
});
