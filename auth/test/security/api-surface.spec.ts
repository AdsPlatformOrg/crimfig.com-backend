import 'reflect-metadata';
import { CanActivate, Controller, Get, Module, Post, UseGuards, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  Public,
  applyOpenApiAuthRequirements,
  isApiDocsEnabled,
  registerApiWelcomeRoute,
} from '@crimfig/shared';

class DummyGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

@Controller('items')
class DefaultProtectedController {
  @Get()
  list() {
    return { items: [] };
  }

  @Get(':id')
  detail() {
    return { ok: true };
  }

  @Public()
  @Get('public/status')
  publicStatus() {
    return { ok: true };
  }
}

@Controller('auth-sample')
class GuardedController {
  @Post('login')
  login() {
    return { ok: true };
  }

  @UseGuards(DummyGuard)
  @Get('profile')
  profile() {
    return { ok: true };
  }
}

@Module({
  controllers: [DefaultProtectedController, GuardedController],
})
class SurfaceTestModule {}

describe('Shared API welcome route and OpenAPI authentication metadata', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('isApiDocsEnabled disables docs in production unless staging or explicitly enabled', () => {
    delete process.env.ENABLE_API_DOCS;
    delete process.env.APP_ENV;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    expect(isApiDocsEnabled(true)).toBe(false);
    expect(isApiDocsEnabled(false)).toBe(true);

    process.env.APP_ENV = 'staging';
    expect(isApiDocsEnabled(true)).toBe(true);

    process.env.ENABLE_API_DOCS = 'false';
    expect(isApiDocsEnabled(false)).toBe(false);
  });

  test('welcome JSON hides docs links when docsEnabled is false and rejects unsafe Host headers', async () => {
    const mod = await Test.createTestingModule({ imports: [SurfaceTestModule] }).compile();
    const app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api');
    registerApiWelcomeRoute(app, {
      service: 'CrimFig Test API',
      code: 'test-api',
      description: 'Test description',
      docsEnabled: false,
      environment: 'production',
    });
    await app.init();
    const server = await app.listen(0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Host: 'evil.example/inject\r\n' },
      }).catch(() => fetch(`http://127.0.0.1:${port}/`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        status: 'ok',
        service: 'CrimFig Test API',
        code: 'test-api',
        environment: 'production',
        links: {
          docs: null,
          openapi: null,
        },
        documentation: 'Interactive API docs are disabled in production.',
      });
    } finally {
      await app.close();
    }
  });

  test('welcome JSON serves docs and health links on / and /api, and OpenAPI marks only authenticated routes with bearer auth', async () => {
    const mod = await Test.createTestingModule({ imports: [SurfaceTestModule] }).compile();
    const app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api');

    const defaultDenyDoc = applyOpenApiAuthRequirements(
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('Default Deny').setVersion('1.0').addBearerAuth().build(),
      ),
      { globalPrefix: 'api', defaultVersion: '1', defaultRequireBearerAuth: true },
    );

    expect(defaultDenyDoc.paths['/api/v1/items']?.get?.security).toEqual([{ bearer: [] }]);
    expect(defaultDenyDoc.paths['/api/v1/items/{id}']?.get?.security).toEqual([{ bearer: [] }]);
    expect(defaultDenyDoc.paths['/api/v1/items/public/status']?.get?.security).toBeUndefined();

    const guardOnlyDoc = applyOpenApiAuthRequirements(
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('Guard Only').setVersion('1.0').addBearerAuth().build(),
      ),
      { globalPrefix: 'api', defaultVersion: '1', defaultRequireBearerAuth: false },
    );

    expect(guardOnlyDoc.paths['/api/v1/auth-sample/profile']?.get?.security).toEqual([{ bearer: [] }]);
    expect(guardOnlyDoc.paths['/api/v1/auth-sample/login']?.post?.security).toBeUndefined();
    expect(guardOnlyDoc.paths['/api/v1/items']?.get?.security).toBeUndefined();

    registerApiWelcomeRoute(app, {
      service: 'CrimFig Ads API',
      code: 'ads-api',
      description: 'Ads Campaign Management & Delivery Microservice',
      docsEnabled: true,
      environment: 'staging',
    });

    await app.init();
    const server = await app.listen(0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    try {
      for (const path of ['/', '/api']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
          status: 'ok',
          service: 'CrimFig Ads API',
          code: 'ads-api',
          description: 'Ads Campaign Management & Delivery Microservice',
          version: '1.0',
          environment: 'staging',
          links: {
            docs: `http://127.0.0.1:${port}/api/docs`,
            openapi: `http://127.0.0.1:${port}/api/docs-json`,
            health: `http://127.0.0.1:${port}/api/v1/health`,
          },
        });
      }
    } finally {
      await app.close();
    }
  });
});
