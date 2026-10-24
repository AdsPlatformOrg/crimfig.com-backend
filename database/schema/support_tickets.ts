import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, index, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * support_ticket_status_enum
 */
export const supportTicketStatusEnum = pgEnum('support_ticket_status', [
  'open',
  'in_progress',
  'waiting_on_user',
  'resolved',
  'closed',
]);

/**
 * support_ticket_priority_enum
 */
export const supportTicketPriorityEnum = pgEnum('support_ticket_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);

/**
 * support_tickets
 *
 * Asynchronous user support and staff moderation inquiries.
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketNumber: varchar('ticket_number', { length: 32 }).notNull().unique(), // e.g. 'TCK-202610-001'
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    app: varchar('app', { length: 32 }).notNull().default('ads'), // 'ads' | 'billing' | 'auth'
    category: varchar('category', { length: 64 }).notNull(), // 'billing', 'campaign_moderation', 'technical', 'fraud_dispute'

    subject: varchar('subject', { length: 255 }).notNull(),
    status: supportTicketStatusEnum('status').notNull().default('open'),
    priority: supportTicketPriorityEnum('priority').notNull().default('medium'),

    assignedToStaffId: uuid('assigned_to_staff_id').references(() => users.id),
    relatedEntityRef: varchar('related_entity_ref', { length: 128 }), // e.g. 'campaign:CMP-123', 'dispute:DSP-456'

    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('support_tickets_user_id_idx').on(t.userId),
    index('support_tickets_status_idx').on(t.status),
    index('support_tickets_app_idx').on(t.app),
    index('support_tickets_assigned_staff_idx').on(t.assignedToStaffId),
    index('support_tickets_updated_at_idx').on(t.updatedAt),
  ],
);

/**
 * support_messages
 *
 * Append-only communication messages on tickets.
 * Distinguishes public messages (visible to user) from internal staff notes.
 */
export const supportMessages = pgTable(
  'support_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id').notNull().references(() => supportTickets.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').notNull().references(() => users.id),

    isStaffReply: boolean('is_staff_reply').notNull().default(false),
    isInternalNote: boolean('is_internal_note').notNull().default(false), // True = internal staff note, never shown to user

    body: text('body').notNull(),
    attachments: jsonb('attachments').default([]), // Array of { name, url, mimeType, sizeBytes }

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('support_messages_ticket_id_idx').on(t.ticketId),
    index('support_messages_created_at_idx').on(t.createdAt),
  ],
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
