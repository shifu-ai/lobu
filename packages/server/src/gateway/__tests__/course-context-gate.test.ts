import type { MessagePayload } from '@lobu/core';
import { describe, expect, test, vi } from 'vitest';
import { attachCourseContextForReviewedScope, requiresCourseContext } from '../orchestration/course-context-gate.js';
const payload = (messageText:string, platformMetadata:Record<string,unknown>={}):MessagePayload => ({userId:'u',agentId:'a',conversationId:'c',channelId:'ch',messageId:'m',platform:'line',messageText,platformMetadata,agentOptions:{}} as MessagePayload);
const candidate = {courseKey:'b',courseEntityId:'course:b',displayName:'B 課',aliases:['B'],status:'active',reasons:['message_alias']};
describe('course context gate', () => {
  test.each([['銷講',true],['三個秘密',true],['課綱',true],['課程',true],['老師回饋',true],['課程會議',true],['課程文件',true],['戰報',true],['招生 Offer',true],['提醒我明天繳電話費',false]])('%s => %s',(text,want)=>expect(requiresCourseContext(payload(text))).toBe(want));
  test('personal reminder bypasses skill, reviewed marker, and active binding unless course wording is explicit',()=>{
    expect(requiresCourseContext(payload('提醒我明天繳電話費',{courseScope:'reviewed'}),{courseSkillEnabled:true,hasActiveCourse:true})).toBe(false);
    expect(requiresCourseContext(payload('提醒我明天整理課程文件'),{courseSkillEnabled:true,hasActiveCourse:true})).toBe(true);
  });
  test('accepts the complete canonical ambiguous contract and preserves order',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'ambiguous',reason:'alias_overlap',candidates:[candidate,{...candidate,courseKey:'a',courseEntityId:'course:a',displayName:'A 課'}]}),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toEqual({status:'clarification_required',candidates:[{courseKey:'b',displayName:'B 課'},{courseKey:'a',displayName:'A 課'}]});
  });
  test.each([
    [{status:'ambiguous',reason:'alias_overlap',candidates:[{courseKey:'b',displayName:'B'}]}],
    [{status:'ambiguous',reason:'unknown',candidates:[candidate]}],
    [{status:'ambiguous',reason:'alias_overlap',candidates:[{...candidate,status:'archived'}]}],
    [{status:'ambiguous',reason:'alias_overlap',candidates:[{...candidate,reasons:['unknown']}]}],
    [{status:'missing',reason:'no_match'}],
  ])('maps malformed closed contract %# to unavailable',async(body)=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toEqual({status:'context_unavailable',reasonCode:'resolver_unavailable'});
  });
  test.each(['no_courses','archived_only'] as const)('maps missing/%s to onboarding',async(reason)=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'missing',reason}),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toEqual({status:'onboarding_required'});
  });
  test.each(['multiple_active_courses','explicit_course_key_not_found'] as const)('allows empty candidate reasons for %s',async(reason)=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'ambiguous',reason,candidates:[{...candidate,reasons:[]}]}),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toMatchObject({status:'clarification_required'});
  });
  test.each(['explicit_course_key','message_name','message_alias','conversation_binding','single_course_default'] as const)('accepts and preserves resolved match %s',async(matchedBy)=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'resolved',confidence:'high',matchedBy:[matchedBy],course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'}}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(canonicalBundle('x')),{status:200}));
    const result=await attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher});
    expect(result).toMatchObject({status:'ready',context:{resolution:{matchedBy:[matchedBy]}}});
  });
  test.each([[],['unknown'],['message_name','message_alias']])('rejects invalid resolved matchedBy %j',async(matchedBy)=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'resolved',confidence:'high',matchedBy,course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'}}),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toEqual({status:'context_unavailable',reasonCode:'resolver_unavailable'});
  });
  test('personal reminder bypasses a failed session store read',async()=>{const manager={getSession:vi.fn().mockRejectedValue(new Error('down'))};await expect(attachCourseContextForReviewedScope(payload('提醒我明天繳電話費'),{baseUrl:'https://t',secret:'s',sessionManager:manager as never,sessionKey:'s'})).resolves.toEqual({status:'not_required'});expect(manager.getSession).not.toHaveBeenCalled();});
  test('accepts the real canonical Toolbox bundle shape and rejects identity mismatch',async()=>{const resolved={status:'resolved',confidence:'high',matchedBy:['message_name'],course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'}};const canonical={course:{courseKey:'x',courseEntityId:'course:x',displayName:'X',aliases:['別名'],status:'active'},profile:{pmRole:null,teacher:null,collaborators:[],audience:null,coursePromise:null,resourceLocations:{}},context:{agentMd:'# 課程 X',contextPackId:'p',version:3,confidence:'high',generatedAt:'2026-07-09T03:00:00.000Z',lastIndexedAt:'2026-07-09T03:59:00.000Z',stale:false},evidence:{confirmed:[],candidates:[]}};const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(resolved),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(canonical),{status:200}));await expect(attachCourseContextForReviewedScope(payload('課程 X'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toMatchObject({status:'ready',context:{context:{confirmedSummary:'# 課程 X'}}});const mismatch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(resolved),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({...canonical,course:{...canonical.course,courseEntityId:'course:y'}}),{status:200}));await expect(attachCourseContextForReviewedScope(payload('課程 X'),{baseUrl:'https://t',secret:'s',fetcher:mismatch})).resolves.toMatchObject({status:'context_unavailable',reasonCode:'bundle_identity_mismatch'});});
  test('accepts producer-sized bundles above 12k and projects agentMd',async()=>{const resolved={status:'resolved',confidence:'high',matchedBy:['message_name'],course:{courseKey:'x',courseEntityId:'course:x',displayName:'x'}};const large:any=canonicalBundle('x');large.context.agentMd='a'.repeat(50000);large.evidence.confirmed=Array.from({length:30},(_,i)=>({id:String(i),sourceType:'doc',sourceId:String(i),sourceUrl:null,sourceTitle:null,excerptPreview:'e'.repeat(500),evidenceKind:'fact',confidence:'high',observedAt:'2026-07-11T00:00:00Z'}));const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(resolved),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(large),{status:200}));const result=await attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher});expect(result.status==='ready'&&result.context.context.confirmedSummary).toHaveLength(8000);large.context.agentMd+='x';const bad=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(resolved),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(large),{status:200}));await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher:bad})).resolves.toMatchObject({status:'context_unavailable'});});
  test('non-text input is safe',()=>expect(requiresCourseContext({...payload('x'),messageText:undefined} as MessagePayload)).toBe(false));
  test('strict session outage fails a bound continuation closed',async()=>{const manager={getSessionStrict:vi.fn().mockRejectedValue(new Error('down'))};await expect(attachCourseContextForReviewedScope(payload('繼續'),{baseUrl:'https://t',secret:'s',sessionManager:manager as never,sessionKey:'s'})).resolves.toEqual({status:'context_unavailable',reasonCode:'session_unavailable'});});
});
function canonicalBundle(key:string){return {course:{courseKey:key,courseEntityId:`course:${key}`,displayName:key,aliases:[],status:'active'},profile:{pmRole:null,teacher:null,collaborators:[],audience:null,coursePromise:null,resourceLocations:{}},context:{agentMd:'s',contextPackId:'p',version:1,confidence:'high',generatedAt:'2026-07-11T00:00:00Z',lastIndexedAt:null,stale:false},evidence:{confirmed:[],candidates:[]}};}
