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
import { ValidationPipe, VersioningType, Logger, ShutdownSignal } from '@nestjs/common';
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
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');

  const docsEnabled = isApiDocsEnabled(process.env.NODE_ENV === 'production');
  if (docsEnabled) {
    const document = applyOpenApiAuthRequirements(
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('CrimFig Chat API')
          .setDescription('Realtime WebSockets, Presence & Messaging Microservice')
          .setVersion('1.0')
          .addBearerAuth()
          .build(),
      ),
      { globalPrefix: 'api', defaultVersion: '1', defaultRequireBearerAuth: false },
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`📖 Chat Swagger docs: http://localhost:${process.env.PORT || 3003}/api/docs`);
  }

  registerApiWelcomeRoute(app, {
    service: 'CrimFig Chat API',
    code: 'chat-api',
    description: 'Realtime WebSockets, Presence & Messaging Microservice',
    version: '1.0',
    docsEnabled,
  });

  const port = process.env.PORT || 3003;
  await app.listen(port);
  logger.log(`🚀 CrimFig Chat API running on port ${port}`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error('Fatal startup error', err);
  process.exit(1);
});
