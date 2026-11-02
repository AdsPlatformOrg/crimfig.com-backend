import {readFileSync} from 'fs';
import {join} from 'path';
import {getTableConfig} from 'drizzle-orm/pg-core';
import * as schema from '@crimfig/database/schema';
const folder=join(__dirname,'../../../database/migrations');
const journal=JSON.parse(readFileSync(join(folder,'meta/_journal.json'),'utf8'));
const source=journal.entries.map((e:any)=>readFileSync(join(folder,e.tag+'.sql'),'utf8')).join('\n');
const pending=readFileSync(join(folder,'0038_funded_rewards_authority.sql'),'utf8');
const required=['rewardsFund','rewardsFundLedger','rewardsFundSettings','rewardsSettingsProposals','adsRewardsSuspensionAudit','rewardsPointsBalances','rewardsPointsLedger','deferredRewardEntitlements','rewardsBadges','rewardsRedemptions','rewardProgramAllocations','rewardProgramIssues','rewardPerformanceReceipts','rewardIssuancePeriods','rewardRecoveryCases','rewardReconciliationReviews','rewardReconciliationApprovals'];
describe('registered reward schema migration coverage',()=>{
 it('does not seed fund cash, balances, settings approvals or issued points',()=>{expect(pending).not.toMatch(/\bINSERT\s+INTO\s+(?:public\.)?"?(?:rewards_|reward_program_|reward_reconciliation_|cfig_ledger)/i);});
 it('registers the pending migration once and preserves monotonic unique timestamps',()=>{expect(journal.entries.filter((e:any)=>e.tag==='0038_funded_rewards_authority')).toHaveLength(1);const times=journal.entries.map((e:any)=>e.when);expect(new Set(times).size).toBe(times.length);expect(times).toEqual([...times].sort((a,b)=>a-b));});
 it.each(required)('defines every runtime column for %s in registered DDL',key=>{const table=getTableConfig((schema as any)[key]);const pattern=new RegExp(String.raw`CREATE TABLE(?: IF NOT EXISTS)? "?${table.name}"?\s*\(([\s\S]*?)\n\);`,'i');const definition=source.match(pattern)?.[1];expect(definition).toBeDefined();for(const column of table.columns)expect(definition).toMatch(new RegExp(String.raw`(?:^|[\s,])"?${column.name}"?\s`,'i'));});
});
