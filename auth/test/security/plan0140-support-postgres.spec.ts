import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
jest.mock('../../src/config/config',()=>({config:{JWT:{ACCESS_SECRET:'support-test-secret'},APP:{AUTH_WEB_URL:'https://auth.example.test'},EMAIL:{},SUPPORT:{OUTBOX_WORKER_ENABLED:false}}}));
import { JwtStrategy } from '../../src/strategies/jwt.strategy';
import { SupportService } from '../../src/modules/support/support.service';
import { SupportController } from '../../src/modules/support/support.controller';
import { AuthStaffGrants } from '../../src/security/auth-staff-grants';
import { DATABASE_TOKEN } from '../../src/modules/database/database.module';
import { EmailService } from '../../src/modules/email/email.service';
const run=process.env.PLAN0009_PG_URL?describe:describe.skip;
run('PLAN0140 real PostgreSQL and authenticated HTTP support',()=>{
 let pool:Pool,service:SupportService,app:any,origin:string,owner:string,other:string,staff:string,unverified:string;
 const mail={sendSupportEmail:jest.fn().mockResolvedValue({accepted:true})};const jwt=new JwtService({secret:'support-test-secret'});
 const grants={rolesFor:(id:string)=>id===staff?['support_agent']:[]};
 const call=async(user:string|undefined,path:string,method='GET',body?:any)=>fetch(origin+'/auth/support/'+path,{method,headers:{...(user?{Authorization:'Bearer '+jwt.sign({sub:user,type:'access'})}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const createBody=()=>({requestId:randomUUID(),category:'technical',subject:'Need help',body:'Please help with this issue.'});
 beforeAll(async()=>{
  const u=new URL(process.env.PLAN0009_PG_URL!);if(u.hostname!=='127.0.0.1'||u.port!=='25440'||u.pathname!=='/plan0009_test'||u.username!=='plan0009test')throw Error('Refusing non-disposable database');
  pool=new Pool({connectionString:u.href,max:12,connectionTimeoutMillis:3000});await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,is_email_verified boolean,status text)');
  await pool.query(readFileSync(resolve(__dirname,'../../../database/migrations/0050_support_center.sql'),'utf8'));
  // Real Nest controller, pipes, Passport JWT guard, staff policy, service and PostgreSQL. Only mail is fake.
  const module=await Test.createTestingModule({imports:[PassportModule.register({defaultStrategy:'jwt'}),ThrottlerModule.forRoot([{name:'medium',ttl:60000,limit:1000}])],controllers:[SupportController],providers:[SupportService,JwtStrategy,{provide:DATABASE_TOKEN,useValue:drizzle(pool)},{provide:AuthStaffGrants,useValue:grants},{provide:EmailService,useValue:mail}]}).compile();
  app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');origin=await app.getUrl();service=module.get(SupportService);
 });
 beforeEach(async()=>{await pool.query('TRUNCATE support_notification_outbox,support_ticket_audit,support_messages,support_tickets,users CASCADE');owner=randomUUID();other=randomUUID();staff=randomUUID();unverified=randomUUID();for(const id of [owner,other,staff,unverified])await pool.query('INSERT INTO users VALUES($1,$2,$3,$4)',[id,id+'@example.test',id!==unverified,'ACTIVE']);mail.sendSupportEmail.mockReset().mockResolvedValue({accepted:true});});
 afterAll(async()=>{await app?.close();await pool?.end();});
 test('unauthenticated, invalid input, unverified and ungranted access fail without writes',async()=>{
  expect((await call(undefined,'tickets','POST',createBody())).status).toBe(401);expect((await call(owner,'tickets','POST',{...createBody(),userId:other})).status).toBe(400);expect((await call(unverified,'tickets','POST',createBody())).status).toBe(403);expect((await call(owner,'admin/tickets')).status).toBe(403);expect((await pool.query('SELECT * FROM support_tickets')).rowCount).toBe(0);
 });
 test('known UUID stays owner scoped, notes never enter user responses, replies persist',async()=>{
  const t=await service.create(owner,createBody());expect((await call(other,'tickets/'+t.id)).status).toBe(404);expect((await call(other,'tickets/'+t.id+'/replies','POST',{requestId:randomUUID(),body:'wrong owner'})).status).toBe(404);expect(await service.list(other,{})).toEqual([]);
  await service.reply(staff,t.id,{requestId:randomUUID(),body:'private staff note'},true,true);await service.reply(staff,t.id,{requestId:randomUUID(),body:'public answer'},true,false);
  const detail:any=await (await call(owner,'tickets/'+t.id)).json();expect(JSON.stringify(detail)).not.toContain('private staff note');expect(detail.data.audit).toBeUndefined();expect(detail.data.messages).toHaveLength(2);expect(detail.data.messages[1].body).toBe('public answer');
  expect((await service.detail(staff,t.id,true)).messages).toHaveLength(3);await service.reply(owner,t.id,{requestId:randomUUID(),body:'Thank you'});expect((await service.detail(owner,t.id)).status).toBe('in_progress');
 });
 test('concurrent replay creates one ticket, message and two jobs; conflicting replay rejected',async()=>{
  const dto=createBody();const results=await Promise.all(Array.from({length:6},()=>service.create(owner,dto)));expect(new Set(results.map(t=>t.id)).size).toBe(1);expect((await pool.query('SELECT * FROM support_messages')).rowCount).toBe(1);expect((await pool.query('SELECT * FROM support_notification_outbox')).rowCount).toBe(2);await expect(service.create(owner,{...dto,body:'Different content'})).rejects.toThrow();
  const more=await Promise.all(Array.from({length:4},()=>service.create(owner,createBody())));expect(new Set(more.map(t=>t.ticket_number)).size).toBe(4);
 });
 test('reply replay, status transitions, assignment and audit remain atomic',async()=>{
  const t=await service.create(owner,createBody());const reply={requestId:randomUUID(),body:'More context'};await Promise.all([service.reply(owner,t.id,reply),service.reply(owner,t.id,reply)]);expect((await service.detail(owner,t.id)).messages).toHaveLength(2);
  await expect(service.update(staff,t.id,{assignedTo:other})).rejects.toThrow();await service.update(staff,t.id,{assignedTo:staff,status:'resolved'});await expect(service.reply(owner,t.id,{requestId:randomUUID(),body:'closed reply'})).rejects.toThrow();await service.update(staff,t.id,{status:'in_progress'});expect((await service.detail(staff,t.id,true)).audit?.length).toBeGreaterThan(2);
 });
 test('first-message failure rolls back ticket, audit and notification jobs',async()=>{
  await pool.query("CREATE FUNCTION reject_support_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER reject_support_message BEFORE INSERT ON support_messages FOR EACH ROW EXECUTE FUNCTION reject_support_message()");
  try{await expect(service.create(owner,createBody())).rejects.toThrow();expect((await pool.query('SELECT * FROM support_tickets')).rowCount).toBe(0);expect((await pool.query('SELECT * FROM support_notification_outbox')).rowCount).toBe(0);}finally{await pool.query('DROP TRIGGER reject_support_message ON support_messages; DROP FUNCTION reject_support_message()');}
 });
 test('fake mail proves independent routing, retry and concurrent job leasing',async()=>{
  const t=await service.create(owner,createBody());mail.sendSupportEmail.mockResolvedValueOnce({accepted:false});await Promise.all([service.dispatch(),service.dispatch()]);expect(mail.sendSupportEmail).toHaveBeenCalledTimes(2);const sent=mail.sendSupportEmail.mock.calls.map(c=>c[0]);expect(sent.find(x=>x.to===owner+'@example.test').bcc).toBeUndefined();expect(sent.find(x=>x.to==='support@crimfig.com').bcc).toBe('jedaccthree@gmail.com');expect(sent.every(x=>!x.textContent.includes('Please help with this issue'))).toBe(true);
  expect((await pool.query("SELECT * FROM support_notification_outbox WHERE status='pending'")).rowCount).toBe(1);await pool.query("UPDATE support_notification_outbox SET next_attempt_at=now() WHERE status='pending'");await service.dispatch();expect((await pool.query("SELECT * FROM support_notification_outbox WHERE status='delivered'")).rowCount).toBe(2);expect((await pool.query('SELECT * FROM support_tickets')).rowCount).toBe(1);
  await service.reply(staff,t.id,{requestId:randomUUID(),body:'Ready to review'},true);await service.dispatch();expect(mail.sendSupportEmail.mock.calls.at(-1)?.[0].to).toBe(owner+'@example.test');expect(mail.sendSupportEmail.mock.calls.at(-1)?.[0].bcc).toBeUndefined();
 });
});
