import { describe, expect, test } from 'bun:test';
import { isCourseEntityId } from '../../utils/course-entity-id.js';
import { parseCourseMemoryApplyCommand } from '../course-memory-runtime-service.js';

// ShiFu 的課程實體 id 由課名衍生，而課名幾乎都是中文，例如
// `course:course-李佳達-ai超級大腦-1dc0e1a7-v2-dea9a10ffcfb`。判準原本是純 ASCII，
// 導致 production 12/12 個課程 profile 的記憶 apply 全部 400（memory.invalid_request），
// 而且同一判準也守著 context pack 寫入與 tools/search 的 entity_ids 檢索——
// 也就是「任何中文課名的課程都寫不進也搜不到課程記憶」。
const REAL_COURSE_ENTITY_IDS = [
  'course:course-李佳達-ai超級大腦-1dc0e1a7-v2-dea9a10ffcfb',
  'course:course-說服力大課-c8b1609c-v2-9a0f10b69716',
  'course:course-朱家泓-技術分析全攻略-1dc0e1a7-v2-2e372ec95531',
  'course:course-ai-超級大腦-4ed1a78d-v2-56375baccac1',
];

// idempotencyKey 把 course key 嵌在裡面，所以同一批課程也踩到 SAFE_ID_PATTERN。
const REAL_IDEMPOTENCY_KEY =
  'workbench:1dc0e1a7-0978-4833-8d14-645bb194a20e:attempt:d5415cba-992f-4afc-a43c-8d126a12fe2f'
  + ':course-李佳達-ai超級大腦-1dc0e1a7-v2-dea9a10ffcfb'
  + ':canonical_course_write:discovery_run:course_memory_apply';

function validCommandBody(overrides: Record<string, unknown> = {}) {
  return {
    contract: { name: 'course_context_projection', schemaVersion: 2 },
    ownerUserId: '1dc0e1a7-0978-4833-8d14-645bb194a20e',
    agentId: 'shifu-u-000000000000',
    courseRevision: 3,
    contextPackId: 'pack-1',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'ascii-key',
    traceId: 'ascii-trace',
    payload: {
      title: 't',
      summary: 's',
      content: 'c',
      semanticType: 'course_context',
      metadata: {},
    },
    ...overrides,
  };
}

describe('course entity id accepts unicode course names', () => {
  test.each(REAL_COURSE_ENTITY_IDS)('accepts production course entity id %s', (entityId) => {
    expect(isCourseEntityId(entityId)).toBe(true);
  });

  test('still accepts plain ASCII ids', () => {
    expect(isCourseEntityId('course:course-ai-bootcamp-4ed1a78d')).toBe(true);
    expect(isCourseEntityId('course_x')).toBe(true);
  });

  // 放寬只加 unicode 字母/數字。所有原本用來保證 URL path / SQL 安全的排除都必須留著，
  // 否則這個判準就失去意義了。
  test.each([
    ['path separator', 'course:a/b'],
    ['whitespace', 'course:a b'],
    ['percent encoding', 'course:a%2Fb'],
    ['dot', 'course:a.b'],
    ['single quote', "course:a'b"],
    ['angle bracket', 'course:a<b'],
    ['newline', 'course:a\nb'],
    ['zero width joiner', 'course:a‍b'],
    ['leading separator', ':course'],
    ['empty', ''],
  ])('still rejects %s', (_label, entityId) => {
    expect(isCourseEntityId(entityId)).toBe(false);
  });

  test('still enforces the 200 code point ceiling', () => {
    expect(isCourseEntityId(`course:${'中'.repeat(193)}`)).toBe(true);
    expect(isCourseEntityId(`course:${'中'.repeat(194)}`)).toBe(false);
  });
});

describe('parseCourseMemoryApplyCommand accepts unicode identifiers', () => {
  test('accepts the real production command shape', () => {
    const command = parseCourseMemoryApplyCommand(
      validCommandBody({ idempotencyKey: REAL_IDEMPOTENCY_KEY }),
      REAL_COURSE_ENTITY_IDS[0]!,
    );
    expect(command.courseEntityId).toBe(REAL_COURSE_ENTITY_IDS[0]!);
    expect(command.idempotencyKey).toBe(REAL_IDEMPOTENCY_KEY);
  });

  test('rejects a course entity id that is still unsafe', () => {
    expect(() => parseCourseMemoryApplyCommand(validCommandBody(), 'course:a/b'))
      .toThrow(/courseEntityId is invalid/);
  });

  test.each([
    ['path separator', 'key/with/slash'],
    ['whitespace', 'key with space'],
    ['percent encoding', 'key%2Fslash'],
  ])('rejects an idempotencyKey containing %s', (_label, idempotencyKey) => {
    expect(() => parseCourseMemoryApplyCommand(
      validCommandBody({ idempotencyKey }),
      REAL_COURSE_ENTITY_IDS[0]!,
    )).toThrow(/must be safe identifiers/);
  });

  test('accepts a unicode traceId', () => {
    const command = parseCourseMemoryApplyCommand(
      validCommandBody({ traceId: 'trace-課程-1' }),
      REAL_COURSE_ENTITY_IDS[0]!,
    );
    expect(command.traceId).toBe('trace-課程-1');
  });
});
