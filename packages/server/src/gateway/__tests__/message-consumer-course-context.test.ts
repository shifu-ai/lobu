import type { MessagePayload } from '@lobu/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MessageConsumer } from '../orchestration/message-consumer.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{delete process.env.TOOLBOX_COURSE_CONTEXT_URL;delete process.env.TOOLBOX_INTERNAL_SECRET;globalThis.fetch=originalFetch;});
function setup(body:unknown, text='課程', metadata:Record<string,unknown>={}) {
  let handler:((job:{id:string;data:MessagePayload})=>Promise<void>)|undefined; const sends:Array<[string,unknown,unknown]>=[];
  const queue={start:vi.fn(),stop:vi.fn(),createQueue:vi.fn(),work:vi.fn(async(_n,cb)=>{handler=cb;}),send:vi.fn(async(n,d,o)=>{sends.push([n,d,o]);return 'job';}),getQueueStats:vi.fn(),isHealthy:vi.fn(),pauseWorker:vi.fn(),resumeWorker:vi.fn()};
  const consumer=new MessageConsumer({queues:{expireInSeconds:1,retryLimit:1}} as never,{listDeployments:vi.fn().mockResolvedValue([]),createWorkerDeployment:vi.fn(),updateDeploymentActivity:vi.fn()} as never,queue as never);
  consumer.setSessionManager({getSession:vi.fn().mockResolvedValue({shifuCourseContext:{courseKey:'old'}}),bindActiveCourse:vi.fn().mockResolvedValue({status:'persisted'})} as never);
  process.env.TOOLBOX_COURSE_CONTEXT_URL='https://t';process.env.TOOLBOX_INTERNAL_SECRET='s';globalThis.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200})) as never;
  const data={userId:'u',agentId:'a',conversationId:'c',channelId:'ch',messageId:'m',platform:'line',messageText:text,platformMetadata:metadata,agentOptions:{}} as MessagePayload;
  return {sends,run:async()=>{await consumer.start();return handler?.({id:'legacy',data});}};
}
describe('message consumer course boundary',()=>{
  test('personal reminder bypasses reviewed and active binding without Toolbox',async()=>{const h=setup({},'提醒我明天繳電話費',{courseScope:'reviewed'});await h.run();expect(fetch).not.toHaveBeenCalled();expect(h.sends.some(([n])=>n.startsWith('thread_message_'))).toBe(true);});
  test('strict malformed ambiguous contract terminalizes and never dispatches worker',async()=>{const h=setup({status:'ambiguous',reason:'multiple_matches',candidates:[{courseKey:'x',displayName:'X'}]});await h.run();expect(h.sends.filter(([n])=>n==='thread_response')).toHaveLength(1);expect(h.sends.some(([n])=>n.startsWith('thread_message_'))).toBe(false);});
});
