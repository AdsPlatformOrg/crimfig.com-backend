import { PgDialect } from 'drizzle-orm/pg-core';
/** Unit-only DB response fixture; actual SQL and scope assertions live in PLAN0156 PostgreSQL tests. */
export function grantFixture(assignments:Record<string,string[]>) {
 const dialect=new PgDialect();
 return {execute:jest.fn(async(query:any)=>{const {params}=dialect.sqlToQuery(query);const roles=assignments[String(params[0]).toLowerCase()]??[];return {rows:roles.map(role_key=>({role_key}))};})};
}
