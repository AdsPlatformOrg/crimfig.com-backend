-- PLAN-0140: compatible support tables, references, replay safety and durable mail.
DO $$ BEGIN CREATE TYPE support_ticket_status AS ENUM ('open','in_progress','waiting_on_user','resolved','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE support_ticket_priority AS ENUM ('low','medium','high','urgent'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SEQUENCE IF NOT EXISTS support_ticket_reference_seq;
CREATE TABLE IF NOT EXISTS support_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_number varchar(32) NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id), app varchar(32) NOT NULL DEFAULT 'ads', category varchar(64) NOT NULL,
 subject varchar(255) NOT NULL, status support_ticket_status NOT NULL DEFAULT 'open',
 priority support_ticket_priority NOT NULL DEFAULT 'medium', assigned_to_staff_id uuid REFERENCES users(id),
 related_entity_ref varchar(128), last_message_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL REFERENCES support_tickets(id),
 sender_id uuid NOT NULL REFERENCES users(id), is_staff_reply boolean NOT NULL DEFAULT false,
 is_internal_note boolean NOT NULL DEFAULT false, body text NOT NULL, attachments jsonb DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS support_ticket_request_unique ON support_tickets(user_id, request_id);
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS support_message_request_unique ON support_messages(ticket_id,sender_id,request_id);
-- Never reset an existing sequence, including gaps left by rolled-back transactions.
SELECT setval('support_ticket_reference_seq', greatest((SELECT last_value FROM support_ticket_reference_seq),
 coalesce((SELECT max(substring(ticket_number from '^#([0-9]+)$')::bigint)+1 FROM support_tickets),1)),false);
CREATE TABLE IF NOT EXISTS support_ticket_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL REFERENCES support_tickets(id),
 actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_notification_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL REFERENCES support_tickets(id),
 message_id uuid NOT NULL REFERENCES support_messages(id), kind text NOT NULL CHECK(kind IN ('ack','staff','reply')),
 recipient_user_id uuid REFERENCES users(id), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid, lease_expires_at timestamptz, delivered_at timestamptz, last_error text,
 UNIQUE(message_id,kind)
);
CREATE INDEX IF NOT EXISTS support_owner_updated_idx ON support_tickets(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS support_queue_idx ON support_tickets(status,assigned_to_staff_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS support_thread_idx ON support_messages(ticket_id,created_at);
