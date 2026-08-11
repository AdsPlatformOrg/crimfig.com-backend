import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'crimfig_core',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin',
});

async function run() {
  const sql = `
  DO $$ BEGIN CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
  DO $$ BEGIN CREATE TYPE user_role AS ENUM ('INDIVIDUAL', 'ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER', 'SYSTEM_ADMIN'); EXCEPTION WHEN duplicate_object THEN null; END $$;
  DO $$ BEGIN CREATE TYPE org_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
  DO $$ BEGIN CREATE TYPE org_role AS ENUM ('OWNER', 'ADMIN', 'MEMBER'); EXCEPTION WHEN duplicate_object THEN null; END $$;
  DO $$ BEGIN CREATE TYPE member_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
  DO $$ BEGIN CREATE TYPE mfa_type AS ENUM ('TOTP', 'FIDO2_WEBAUTHN', 'BACKUP_CODES'); EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar(255) NOT NULL UNIQUE,
    phone varchar(30),
    password_hash text NOT NULL,
    status user_status DEFAULT 'PENDING_VERIFICATION' NOT NULL,
    is_email_verified boolean DEFAULT false NOT NULL,
    is_phone_verified boolean DEFAULT false NOT NULL,
    mfa_enabled boolean DEFAULT false NOT NULL,
    preferred_locale varchar(10) DEFAULT 'en' NOT NULL,
    last_login_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS individual_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    full_name varchar(255),
    display_name varchar(100),
    avatar_url text,
    bio text,
    timezone varchar(64) DEFAULT 'Africa/Lagos',
    country varchar(2) DEFAULT 'NG',
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    organization_id uuid,
    action varchar(100) NOT NULL,
    resource_type varchar(100),
    resource_id varchar(255),
    metadata jsonb,
    ip_address varchar(45),
    user_agent text,
    request_id varchar(100),
    success varchar(10) DEFAULT 'true' NOT NULL,
    error_code varchar(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  `;

  try {
    await pool.query(sql);
    console.log('Tables created successfully in crimfig_core!');
  } catch (err) {
    console.error('Error creating tables:', err);
  } finally {
    await pool.end();
  }
}

run();
