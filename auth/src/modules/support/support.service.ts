import { Injectable, Inject, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { createHash, randomUUID } from 'crypto';
import { DATABASE_TOKEN } from '../database/database.module';
import { AuthStaffGrants } from '../../security/auth-staff-grants';
import { EmailService } from '../email/email.service';
import { CreateSupportDto, ReplySupportDto, UpdateSupportDto, SupportQueryDto } from './support.dto';
import { SUPPORT_STAFF_MAIL, checkSupportTransition, ticketReference } from './support-policy';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ticketColumns = sql`id,ticket_number,category,subject,status,priority,assigned_to_staff_id,last_message_at,resolved_at,created_at,updated_at`;
@Injectable()
export class SupportService {
 constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>, private readonly grants: AuthStaffGrants, private readonly email: EmailService) {}
 async requireStaff(userId: string, conn:any=this.db) {
  if (!(await this.grants.rolesFor(userId,conn)).some(role => role === 'super_admin' || role === 'support_agent')) throw new ForbiddenException('Platform Support authorization required');
 }
 private async transaction<T>(run: (tx: any) => Promise<T>): Promise<T> {
  return this.db.transaction(async tx => { await tx.execute(sql`SET LOCAL lock_timeout = '3s'`); await tx.execute(sql`SET LOCAL statement_timeout = '8s'`); return run(tx); });
 }
 private async lock(tx: any, id: string, userId: string, staff: boolean) {
  if(staff) await this.requireStaff(userId,tx);
  const result = await tx.execute(sql`SELECT id,user_id,status FROM support_tickets WHERE id=${id}::uuid AND (${staff} OR user_id=${userId}::uuid) FOR UPDATE`);
  if (!result.rows[0]) throw new NotFoundException('Request not found'); return result.rows[0];
 }
 async create(userId: string, dto: CreateSupportDto) {
  if (!dto.subject.trim() || dto.body.trim().length < 10) throw new BadRequestException('Enter a subject and description');
  const fingerprint=hash([dto.category,dto.subject,dto.body]);
  return this.transaction(async tx => {
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + dto.requestId},0))`);
   const old=await tx.execute(sql`SELECT id,ticket_number,request_hash FROM support_tickets WHERE user_id=${userId}::uuid AND request_id=${dto.requestId}::uuid`);
   if(old.rows[0]) { if(old.rows[0].request_hash!==fingerprint) throw new ConflictException('Request key already used for different content'); return {id:old.rows[0].id,ticket_number:old.rows[0].ticket_number}; }
   const owner=await tx.execute(sql`SELECT id FROM users WHERE id=${userId}::uuid AND is_email_verified=true AND status='ACTIVE'`);
   if(!owner.rows[0]) throw new ForbiddenException('A verified active account is required');
   const sequence=await tx.execute(sql`SELECT nextval('support_ticket_reference_seq') value`);
   const reference=ticketReference(sequence.rows[0].value); const id=randomUUID(); const messageId=randomUUID();
   await tx.execute(sql`INSERT INTO support_tickets(id,ticket_number,user_id,category,subject,request_id,request_hash) VALUES(${id}::uuid,${reference},${userId}::uuid,${dto.category},${dto.subject.trim()},${dto.requestId}::uuid,${fingerprint})`);
   await tx.execute(sql`INSERT INTO support_messages(id,ticket_id,sender_id,body) VALUES(${messageId}::uuid,${id}::uuid,${userId}::uuid,${dto.body.trim()})`);
   await tx.execute(sql`INSERT INTO support_notification_outbox(ticket_id,message_id,kind,recipient_user_id) VALUES(${id}::uuid,${messageId}::uuid,'ack',${userId}::uuid),(${id}::uuid,${messageId}::uuid,'staff',NULL)`);
   await tx.execute(sql`INSERT INTO support_ticket_audit(ticket_id,actor_id,action) VALUES(${id}::uuid,${userId}::uuid,'created')`);
   return {id,ticket_number:reference};
  });
 }
 async list(userId: string, query: SupportQueryDto, staff=false) {
  if(staff) await this.requireStaff(userId);
  const offset=Number(query.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000) throw new BadRequestException('Invalid offset');
  return (await this.db.execute<any>(sql`SELECT ${ticketColumns} FROM support_tickets WHERE (${staff} OR user_id=${userId}::uuid)
   AND (${query.status??null}::text IS NULL OR status::text=${query.status??null})
   AND (${query.category??null}::text IS NULL OR category=${query.category??null})
   AND (${query.priority??null}::text IS NULL OR priority::text=${query.priority??null})
   AND (${query.search??null}::text IS NULL OR ticket_number=${query.search??null})
   AND (${query.queue??null}::text IS NULL OR (${query.queue??null}='new' AND status='open' AND assigned_to_staff_id IS NULL)
    OR (${query.queue??null}='assigned' AND assigned_to_staff_id=${userId}::uuid)
    OR (${query.queue??null}='waiting' AND status='waiting_on_user') OR (${query.queue??null}='resolved' AND status IN ('resolved','closed')))
   ORDER BY updated_at DESC,id LIMIT 50 OFFSET ${offset}`)).rows;
 }
 async unreadCount(staffId: string) {
  await this.requireStaff(staffId);
  const { rows } = await this.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM support_messages AS message
    WHERE NOT message.is_staff_reply AND NOT message.is_internal_note
      AND NOT EXISTS (
        SELECT 1 FROM support_staff_message_reads AS receipt
        WHERE receipt.staff_id = ${staffId}::uuid AND receipt.message_id = message.id
      )
  `);
  return rows[0].count;
 }
 async markRead(staffId: string, ticketId: string, messageIds: string[]) {
  await this.requireStaff(staffId);
  await this.db.execute(sql`
    INSERT INTO support_staff_message_reads (staff_id, message_id)
    SELECT ${staffId}::uuid, message.id FROM support_messages AS message
    WHERE message.ticket_id = ${ticketId}::uuid
      AND message.id IN (${sql.join(messageIds.map(id => sql`${id}::uuid`), sql`, `)})
      AND NOT message.is_staff_reply AND NOT message.is_internal_note
    ON CONFLICT DO NOTHING
  `);
 }
 async detail(userId: string,id: string,staff=false): Promise<Record<string, any>> {
  if(staff) await this.requireStaff(userId);
  const ticket=(await this.db.execute<any>(sql`SELECT ${ticketColumns} FROM support_tickets WHERE id=${id}::uuid AND (${staff} OR user_id=${userId}::uuid)`)).rows[0];
  if(!ticket) throw new NotFoundException('Request not found');
  const messages=(await this.db.execute<any>(sql`SELECT id,body,is_staff_reply,is_internal_note,created_at FROM support_messages WHERE ticket_id=${id}::uuid AND (${staff} OR is_internal_note=false) ORDER BY created_at,id`)).rows;
  const audit=staff?(await this.db.execute<any>(sql`SELECT actor_id,action,details,created_at FROM support_ticket_audit WHERE ticket_id=${id}::uuid ORDER BY created_at,id`)).rows:undefined;
  return {...ticket,messages,...(staff?{audit}:{})};
 }
 async reply(userId: string,id: string,dto: ReplySupportDto,staff=false,internal=false) {
  if(staff) await this.requireStaff(userId); else if(internal) throw new ForbiddenException();
  if(!dto.body.trim()) throw new BadRequestException('Enter a message');
  return this.transaction(async tx=>{
   const ticket=await this.lock(tx,id,userId,staff); const fingerprint=hash([dto.body,internal]);
   const old=await tx.execute(sql`SELECT id,request_hash FROM support_messages WHERE ticket_id=${id}::uuid AND sender_id=${userId}::uuid AND request_id=${dto.requestId}::uuid`);
   if(old.rows[0]) {if(old.rows[0].request_hash!==fingerprint) throw new ConflictException('Request key already used');return {id:old.rows[0].id};}
   if(!staff && ['resolved','closed'].includes(ticket.status)) throw new ConflictException('This request is resolved or closed. Start a new request if you need more help.');
   const messageId=randomUUID();
   await tx.execute(sql`INSERT INTO support_messages(id,ticket_id,sender_id,body,is_staff_reply,is_internal_note,request_id,request_hash) VALUES(${messageId}::uuid,${id}::uuid,${userId}::uuid,${dto.body.trim()},${staff},${internal},${dto.requestId}::uuid,${fingerprint})`);
   if(!internal) {
    await tx.execute(sql`UPDATE support_tickets SET last_message_at=now(),updated_at=now(),status=${staff?'waiting_on_user':'in_progress'}::support_ticket_status,resolved_at=NULL WHERE id=${id}::uuid`);
    await tx.execute(sql`INSERT INTO support_notification_outbox(ticket_id,message_id,kind,recipient_user_id) VALUES(${id}::uuid,${messageId}::uuid,${staff?'reply':'staff'},${staff?ticket.user_id:null}::uuid)`);
   } else await tx.execute(sql`UPDATE support_tickets SET updated_at=now() WHERE id=${id}::uuid`);
   await tx.execute(sql`INSERT INTO support_ticket_audit(ticket_id,actor_id,action) VALUES(${id}::uuid,${userId}::uuid,${internal?'internal_note':'public_reply'})`);
   return {id:messageId};
  });
 }
 async update(userId:string,id:string,dto:UpdateSupportDto) {
  await this.requireStaff(userId);
  if(dto.unassign && dto.assignedTo) throw new BadRequestException('Choose an assignee or unassign');
  if(dto.assignedTo) await this.requireStaff(dto.assignedTo);
  return this.transaction(async tx=>{
   const ticket=await this.lock(tx,id,userId,true);if(dto.status) checkSupportTransition(ticket.status,dto.status);
   await tx.execute(sql`UPDATE support_tickets SET status=coalesce(${dto.status??null}::support_ticket_status,status),priority=coalesce(${dto.priority??null}::support_ticket_priority,priority),
    assigned_to_staff_id=CASE WHEN ${dto.unassign===true} THEN NULL ELSE coalesce(${dto.assignedTo??null}::uuid,assigned_to_staff_id) END,
    resolved_at=CASE WHEN ${dto.status??null}::text IN ('resolved','closed') THEN now() WHEN ${dto.status??null}::text IS NOT NULL THEN NULL ELSE resolved_at END,updated_at=now() WHERE id=${id}::uuid`);
   await tx.execute(sql`INSERT INTO support_ticket_audit(ticket_id,actor_id,action,details) VALUES(${id}::uuid,${userId}::uuid,'updated',${JSON.stringify(dto)}::jsonb)`);
   return {id};
  });
 }
 async dispatch() {
  const lease=randomUUID();
  const jobs=await this.transaction(async tx=>(await tx.execute(sql`WITH due AS (SELECT id FROM support_notification_outbox WHERE next_attempt_at<=now() AND (status='pending' OR (status='sending' AND lease_expires_at<now())) ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED)
   UPDATE support_notification_outbox o SET status='sending',lease_id=${lease}::uuid,lease_expires_at=now()+interval '5 minutes',attempts=attempts+1 FROM due WHERE o.id=due.id RETURNING o.*`)).rows);
  for(const job of jobs) {
   try {
    const result=await this.db.execute<any>(sql`SELECT t.ticket_number,t.id,u.email,u.is_email_verified FROM support_tickets t JOIN users u ON u.id=coalesce(${job.recipient_user_id}::uuid,t.user_id) WHERE t.id=${job.ticket_id}::uuid`);
    const ticket=result.rows[0];if(!ticket || !ticket.is_email_verified) throw new Error('VERIFIED_RECIPIENT_REQUIRED');
    const sent=await this.email.sendSupportEmail({to:job.kind==='staff'?SUPPORT_STAFF_MAIL.to:ticket.email,...(job.kind==='staff'?{bcc:SUPPORT_STAFF_MAIL.bcc}:{}),...this.email.buildSupportEmailContent(job.kind,ticket)});
    if(!sent.accepted) throw new Error('MAIL_NOT_ACCEPTED');
    await this.db.execute<any>(sql`UPDATE support_notification_outbox SET status='delivered',delivered_at=now(),lease_id=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=${job.id}::uuid AND lease_id=${lease}::uuid`);
   } catch {
    await this.db.execute<any>(sql`UPDATE support_notification_outbox SET status='pending',next_attempt_at=now()+least(attempts*attempts,360)::int*interval '1 minute',lease_id=NULL,lease_expires_at=NULL,last_error='DELIVERY_FAILED' WHERE id=${job.id}::uuid AND lease_id=${lease}::uuid`);
   }
  }
  return jobs.length;
 }
}
