CREATE TABLE support_staff_message_reads (
  staff_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, message_id)
);
--> statement-breakpoint
CREATE INDEX support_staff_message_reads_message_idx ON support_staff_message_reads (message_id);
