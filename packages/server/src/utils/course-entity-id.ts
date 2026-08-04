// 課程實體 id 由課名衍生，而課名常常不是 ASCII（ShiFu 的課程幾乎都是中文，例如
// `course:course-李佳達-ai超級大腦-1dc0e1a7-v2-dea9a10ffcfb`）。所以字元集允許 unicode
// 的字母與數字，但仍然排除所有會讓這個 id 在 URL path / SQL / JSON 裡變得不安全或不唯一的
// 東西：路徑分隔符、空白、控制與格式字元（含零寬字元）、引號、角括號、百分號、點。
// 放寬只加字母數字——不要為了讓某個呼叫端過關而放進標點。
export const COURSE_ENTITY_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}:_-]{0,199}$/u;

export function isCourseEntityId(value: unknown): value is string {
  return typeof value === 'string' && COURSE_ENTITY_ID_PATTERN.test(value);
}
