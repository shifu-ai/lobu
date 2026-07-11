import {describe,expect,test,vi} from 'vitest';
import {searchContentBySingleQuery} from '../search-path';
const options={organization_id:'org',limit:8,sort_by:'score' as const,statement_timeout_ms:750};
function db(fail:boolean){const calls:string[]=[];const tx={unsafe:vi.fn(async(sql:string)=>{calls.push(sql);if(!sql.startsWith('SET LOCAL')&&fail)throw new Error('statement timeout');return[]})};return{calls,sql:{begin:vi.fn(async(fn:any)=>fn(tx)),unsafe:vi.fn()} as any};}
describe('explicit content search timeout',()=>{
 test('wraps embedding-outage direct text search in SET LOCAL and rethrows failure',async()=>{const fake=db(true);await expect(searchContentBySingleQuery(fake.sql,'受眾',options)).rejects.toThrow('statement timeout');expect(fake.calls[0]).toBe('SET LOCAL statement_timeout = 750');});
 test('wraps explicit embedding candidate search and rethrows failure',async()=>{const fake=db(true);await expect(searchContentBySingleQuery(fake.sql,'audience',{...options,query_embedding:[1],approximate_candidate_search:true})).rejects.toThrow('statement timeout');expect(fake.calls[0]).toBe('SET LOCAL statement_timeout = 750');});
 test('preserves implicit candidate timeout fail-open behavior',async()=>{const fake=db(true);await expect(searchContentBySingleQuery(fake.sql,'audience',{organization_id:'org',limit:8,sort_by:'score',query_embedding:[1],approximate_candidate_search:true})).resolves.toMatchObject({content:[]});expect(fake.calls[0]).toContain('SET LOCAL statement_timeout');});
});
