import { INestApplication, RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { IS_PUBLIC_KEY } from '../decorators';

export interface ApiWelcomeOptions {
  service: string;
  code: string;
  description: string;
  version?: string;
  docsPath?: string;
  healthPath?: string;
  docsEnabled: boolean;
  environment?: string;
}

export interface OpenApiAuthOptions {
  globalPrefix?: string;
  defaultVersion?: string | null;
  defaultRequireBearerAuth?: boolean;
  schemeName?: string;
}

const REQUEST_METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
};

const OPENAPI_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

export function isApiDocsEnabled(isProduction?: boolean): boolean {
  if (process.env.ENABLE_API_DOCS === 'false') return false;
  if (process.env.ENABLE_API_DOCS === 'true') return true;
  if (
    process.env.APP_ENV?.toLowerCase() === 'staging' ||
    process.env.RAILWAY_ENVIRONMENT_NAME?.toLowerCase() === 'staging'
  ) {
    return true;
  }
  return !(isProduction ?? process.env.NODE_ENV === 'production');
}

export function resolveApiEnvironment(isProduction?: boolean): string {
  const explicit = (process.env.APP_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (isProduction ?? process.env.NODE_ENV === 'production') return 'production';
  return (process.env.NODE_ENV || 'development').trim().toLowerCase();
}

function normalizePathSegments(segments: Array<string | null | undefined>): string {
  const joined = segments
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return '/' + joined.replace(/:([a-zA-Z0-9_]+)(\([^)]*\))?/g, '{$1}');
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [''];
}

function resolveVersionSegments(
  methodVersion: unknown,
  controllerVersion: unknown,
  defaultVersion: string | null | undefined,
): Array<string | null> {
  const raw = methodVersion !== undefined ? methodVersion : controllerVersion !== undefined ? controllerVersion : defaultVersion;
  if (raw === undefined || raw === null || raw === VERSION_NEUTRAL) return [null];
  const values = Array.isArray(raw) ? raw : [raw];
  const out: Array<string | null> = [];
  for (const v of values) {
    if (v === VERSION_NEUTRAL || v === null || v === undefined) out.push(null);
    else out.push(`v${String(v).replace(/^v/i, '')}`);
  }
  return out.length ? out : [null];
}

export function registerApiWelcomeRoute(app: INestApplication, options: ApiWelcomeOptions): void {
  const httpInstance = app.getHttpAdapter().getInstance();
  const docsPath = options.docsPath || '/api/docs';
  const openApiPath = `${docsPath}-json`;
  const healthPath = options.healthPath || '/api/v1/health';
  const version = options.version || '1.0';
  const environment = options.environment || resolveApiEnvironment();

  const handler = (req: any, res: any) => {
    const rawHost = typeof req?.get === 'function' ? req.get('host') : req?.headers?.host;
    const host = typeof rawHost === 'string' && SAFE_HOST_PATTERN.test(rawHost) ? rawHost : null;
    const forwardedProto = typeof req?.get === 'function' ? req.get('x-forwarded-proto') : req?.headers?.['x-forwarded-proto'];
    const proto = req?.secure || String(forwardedProto || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const baseUrl = host ? `${proto}://${host}` : '';
    const link = (p: string) => (baseUrl ? `${baseUrl}${p}` : p);

    res.status(200).json({
      status: 'ok',
      service: options.service,
      code: options.code,
      description: options.description,
      version,
      environment,
      links: {
        docs: options.docsEnabled ? link(docsPath) : null,
        openapi: options.docsEnabled ? link(openApiPath) : null,
        health: link(healthPath),
      },
      ...(options.docsEnabled ? {} : { documentation: 'Interactive API docs are disabled in production.' }),
    });
  };

  httpInstance.get('/', handler);
  httpInstance.get('/api', handler);
}

export function applyOpenApiAuthRequirements(
  app: INestApplication,
  document: OpenAPIObject,
  options: OpenApiAuthOptions = {},
): OpenAPIObject {
  const globalPrefix = options.globalPrefix ?? 'api';
  const defaultVersion = options.defaultVersion === undefined ? '1' : options.defaultVersion;
  const defaultRequireBearerAuth = Boolean(options.defaultRequireBearerAuth);
  const schemeName = options.schemeName ?? 'bearer';

  const authByOperation = new Map<string, boolean>();
  const modulesContainer = app.get(ModulesContainer, { strict: false });

  if (modulesContainer) {
    for (const moduleRef of modulesContainer.values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const controller = wrapper.metatype;
        if (!controller || !controller.prototype) continue;
        const controllerPaths = toStringArray(Reflect.getMetadata(PATH_METADATA, controller));
        const controllerVersion = Reflect.getMetadata(VERSION_METADATA, controller);
        const controllerPublic = Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, controller));
        const controllerGuards = Reflect.getMetadata(GUARDS_METADATA, controller);
        const controllerHasGuards = Array.isArray(controllerGuards) && controllerGuards.length > 0;

        for (const propName of Object.getOwnPropertyNames(controller.prototype)) {
          if (propName === 'constructor') continue;
          const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, propName);
          const methodHandler = descriptor?.value;
          if (typeof methodHandler !== 'function') continue;

          const methodCode = Reflect.getMetadata(METHOD_METADATA, methodHandler);
          if (methodCode === undefined) continue;

          const methodPaths = toStringArray(Reflect.getMetadata(PATH_METADATA, methodHandler));
          const methodVersion = Reflect.getMetadata(VERSION_METADATA, methodHandler);
          const methodPublic = Reflect.getMetadata(IS_PUBLIC_KEY, methodHandler);
          const isPublic = methodPublic === true || (methodPublic !== false && controllerPublic);
          const methodGuards = Reflect.getMetadata(GUARDS_METADATA, methodHandler);
          const hasGuards = controllerHasGuards || (Array.isArray(methodGuards) && methodGuards.length > 0);
          const requiresAuth = !isPublic && (defaultRequireBearerAuth || hasGuards);

          const verbs =
            methodCode === RequestMethod.ALL
              ? [...OPENAPI_HTTP_METHODS]
              : REQUEST_METHOD_NAMES[methodCode]
                ? [REQUEST_METHOD_NAMES[methodCode]]
                : [];
          const versions = resolveVersionSegments(methodVersion, controllerVersion, defaultVersion);

          for (const versionSeg of versions) {
            for (const cPath of controllerPaths) {
              for (const mPath of methodPaths) {
                const fullPath = normalizePathSegments([globalPrefix, versionSeg, cPath, mPath]);
                for (const verb of verbs) {
                  authByOperation.set(`${verb}:${fullPath}`, requiresAuth);
                }
              }
            }
          }
        }
      }
    }
  }

  let anyBearerApplied = false;
  for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const verb of OPENAPI_HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[verb];
      if (!op || typeof op !== 'object') continue;
      const lookup = authByOperation.get(`${verb}:${pathKey}`);
      const requiresAuth = lookup !== undefined ? lookup : defaultRequireBearerAuth;
      if (requiresAuth) {
        const existing = Array.isArray(op.security) ? op.security : [];
        const hasScheme = existing.some(
          (entry: Record<string, unknown>) => entry && typeof entry === 'object' && schemeName in entry,
        );
        op.security = hasScheme ? existing : [...existing, { [schemeName]: [] }];
        anyBearerApplied = true;
      } else if (lookup === false) {
        delete op.security;
      }
    }
  }

  if (anyBearerApplied) {
    document.components = document.components ?? {};
    document.components.securitySchemes = document.components.securitySchemes ?? {};
    if (!document.components.securitySchemes[schemeName]) {
      document.components.securitySchemes[schemeName] = {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      };
    }
  }

  return document;
}
