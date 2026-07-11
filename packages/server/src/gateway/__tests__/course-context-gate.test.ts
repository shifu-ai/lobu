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
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'resolved',confidence:'high',matchedBy:[matchedBy],course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'}}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'},context:{contextPackId:'p',version:1,stale:false,confirmedSummary:'s'}}),{status:200}));
    const result=await attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher});
    expect(result).toMatchObject({status:'ready',context:{resolution:{matchedBy:[matchedBy]}}});
  });
  test.each([[],['unknown'],['message_name','message_alias']])('rejects invalid resolved matchedBy %j',async(matchedBy)=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'resolved',confidence:'high',matchedBy,course:{courseKey:'x',courseEntityId:'course:x',displayName:'X'}}),{status:200}));
    await expect(attachCourseContextForReviewedScope(payload('課程'),{baseUrl:'https://t',secret:'s',fetcher})).resolves.toEqual({status:'context_unavailable',reasonCode:'resolver_unavailable'});
  });
});
