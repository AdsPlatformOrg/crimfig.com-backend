/**
 * Crimfig Audit API — Typed Configuration
 *
 * RULE: process.env is ONLY read here. All other code imports from this file.
 * NEVER use process.env directly in services, controllers, or guards.
 */

export const config = {
  NODE_ENV: (process.env.NODE_ENV ?? 'development') as 'development' | 'test' | 'staging' | 'production',
  PORT: Number(process.env.PORT ?? 3002),

  DB: {
    HOST: process.env.DB_HOST ?? 'localhost',
    PORT: Number(process.env.DB_PORT ?? 5432),
    NAME: process.env.DB_NAME ?? 'crimfig_core',
    USER: process.env.DB_USER ?? 'crimfig_user',
    PASSWORD: process.env.DB_PASSWORD ?? '',
    SSL: process.env.DB_SSL === 'true',
    POOL_MAX: Number(process.env.DB_POOL_MAX ?? 10),
  },

  NATS: {
    URL: process.env.NATS_URL ?? 'nats://localhost:4222',
  },

  APP: {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'],
  },

  IS_PRODUCTION: process.env.NODE_ENV === 'production',
  IS_DEVELOPMENT: process.env.NODE_ENV === 'development',
} as const;

export type Config = typeof config;
