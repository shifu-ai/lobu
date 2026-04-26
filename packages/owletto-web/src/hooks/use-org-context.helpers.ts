export interface ResolveOrgContextInput {
  isAuthenticated: boolean;
  activeOrgId?: string | null;
  activeOrgSlug?: string | null;
  urlOrgSlug?: string | null;
  personalOrgSlug?: string | null;
  firstUserOrgSlug?: string | null;
}

export interface ResolvedOrgContext {
  resolvedOrgSlug: string | null;
  resolvedOrganizationId: string | null;
  currentOwner: string | null;
  hasOrgContext: boolean;
}

export function resolveOrgContext(input: ResolveOrgContextInput): ResolvedOrgContext {
  const resolvedOrgSlug = input.urlOrgSlug || input.activeOrgSlug || null;
  const resolvedOrganizationId = input.urlOrgSlug
    ? input.activeOrgSlug === input.urlOrgSlug
      ? (input.activeOrgId ?? null)
      : null
    : (input.activeOrgId ?? null);

  const currentOwner = input.isAuthenticated
    ? input.urlOrgSlug ||
      input.activeOrgSlug ||
      input.personalOrgSlug ||
      input.firstUserOrgSlug ||
      null
    : input.urlOrgSlug || null;

  const hasOrgContext = Boolean(input.urlOrgSlug || resolvedOrganizationId);

  return {
    resolvedOrgSlug,
    resolvedOrganizationId,
    currentOwner,
    hasOrgContext,
  };
}
