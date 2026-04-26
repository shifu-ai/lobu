export function slugifyAgentId(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  const prefixed = normalized
    ? /^[a-z]/.test(normalized)
      ? normalized
      : `agent-${normalized}`
    : 'agent';

  return prefixed.slice(0, 60).replace(/-+$/g, '') || 'agent';
}

export function buildGeneratedAgentId(name: string, existingAgentIds: string[]): string {
  const existingIds = new Set(existingAgentIds);
  const base = slugifyAgentId(name);
  let candidate = base;
  let index = 2;

  while (existingIds.has(candidate)) {
    const suffix = `-${index}`;
    const trimmedBase =
      base.slice(0, Math.max(1, 60 - suffix.length)).replace(/-+$/g, '') || 'agent';
    candidate = `${trimmedBase}${suffix}`;
    index += 1;
  }

  return candidate;
}
