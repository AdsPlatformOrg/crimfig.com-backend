/**
 * Crimfig Auth API — Typed Configuration
 *
 * RULE: process.env is ONLY read here. All other code imports from this file.
 * NEVER use process.env directly in services, controllers, or guards.
 */

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`[config] Missing required environment variable: ${key}`);
  return value;
};

export const config = {
  NODE_ENV: (process.env.NODE_ENV ?? 'development') as 'development' | 'test' | 'staging' | 'production',
  PORT: Number(process.env.PORT ?? 4000),

  DB: {
    HOST: required('DB_HOST'),
    PORT: Number(process.env.DB_PORT ?? 5432),
    NAME: required('DB_NAME'),
    USER: required('DB_USER'),
    PASSWORD: required('DB_PASSWORD'),
    SSL: process.env.DB_SSL === 'true',
  },

  JWT: {
    ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
    REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
    ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  },

  OAUTH: {
    ISSUER: process.env.OAUTH_ISSUER ?? 'https://auth.crimfig.com',
    AUTH_CODE_EXPIRES_SECONDS: Number(process.env.OAUTH_AUTH_CODE_EXPIRES_SECONDS ?? 300),
  },

  REDIS: {
    URL: required('REDIS_URL'),
  },

  EMAIL: {
    BREVO_API_KEY: required('BREVO_API_KEY'),
    FROM: process.env.EMAIL_FROM ?? 'noreply@crimfig.com',
    FROM_NAME: process.env.EMAIL_FROM_NAME ?? 'CrimFig',
  },

  ENCRYPTION: {
    KEY: required('ENCRYPTION_KEY'),
  },

  APP: {
    AUTH_WEB_URL: process.env.AUTH_WEB_URL ?? 'http://localhost:3000',
    ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','),
  },

  IS_PRODUCTION: process.env.NODE_ENV === 'production',
  IS_DEVELOPMENT: process.env.NODE_ENV === 'development',
} as const;

export type Config = typeof config;
