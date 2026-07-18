export const COURSE_ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

export function isCourseEntityId(value: unknown): value is string {
  return typeof value === 'string' && COURSE_ENTITY_ID_PATTERN.test(value);
}
