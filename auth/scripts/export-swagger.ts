import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

async function exportSwagger() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('CrimFig Auth API')
    .setDescription('Central OAuth2/OIDC server, JWT, MFA, Multi-Owner Organizations, App Consent')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('crimfig_rt')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = path.resolve(__dirname, '../../docs/api/auth-api.json');

  // Ensure target directory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2), 'utf8');

  console.log(`✅ OpenAPI spec exported successfully to ${outPath}`);
  await app.close();
  process.exit(0);
}

exportSwagger().catch((err) => {
  console.error('❌ Failed to export OpenAPI spec:', err);
  process.exit(1);
});
