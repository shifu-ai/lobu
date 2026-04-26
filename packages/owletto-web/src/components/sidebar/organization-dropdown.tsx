import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronDown, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useClickOutside } from '@/hooks/use-click-outside';
import { useOrgContext } from '@/hooks/use-org-context';
import { type Organization as ApiOrganization, useOrganizations } from '@/lib/api';
import { organization } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { stripOwnerPrefix } from '@/lib/subdomain-history';
import { buildOwnerHref, getSubdomainOwner, getSubdomainZone } from '@/lib/subdomain';
import { isOrganizationActive, resolveOrganizationDisplay } from './app-sidebar.helpers';

function slugifyOrganizationName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getRenamedOrganizationPath(currentPath: string, currentSlug: string, nextSlug: string) {
  const segments = currentPath.split('/');
  if (segments[1] === currentSlug) {
    segments[1] = nextSlug;
    return segments.join('/') || '/';
  }
  return `/${nextSlug}`;
}

function WorkspaceRow({
  organization: org,
  isActive,
  onSelect,
  onManage,
}: {
  organization: ApiOrganization;
  isActive: boolean;
  onSelect: () => void;
  onManage?: (organization: ApiOrganization) => void;
}) {
  const initial = org.name[0]?.toUpperCase() || 'W';

  return (
    <CommandItem
      onSelect={onSelect}
      value={org.name}
      className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 pr-1 text-sm"
    >
      <div className="h-6 w-6 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
        {org.logo ? (
          <img
            src={org.logo}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="text-xs font-medium">{initial}</span>
        )}
      </div>
      <span className="flex-1 truncate text-left">{org.name}</span>
      {onManage ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Manage ${org.name}`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onManage(org);
          }}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      ) : null}
      {isActive && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </CommandItem>
  );
}

export function OrganizationDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgSlug, setNewOrgSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [managedOrg, setManagedOrg] = useState<ApiOrganization | null>(null);
  const [manageOrgName, setManageOrgName] = useState('');
  const [manageOrgSlug, setManageOrgSlug] = useState('');
  const [manageSlugTouched, setManageSlugTouched] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [isSavingOrg, setIsSavingOrg] = useState(false);
  const [isDeletingOrg, setIsDeletingOrg] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: allOrgs } = useOrganizations();
  const { activeOrganization: activeOrg } = useAuthState();

  const { session, urlOrgSlug } = useOrgContext();
  const isAuthenticated = !!session;

  const memberOrgs = useMemo(() => (allOrgs || []).filter((o) => o.is_member), [allOrgs]);
  const publicOnlyOrgs = useMemo(() => (allOrgs || []).filter((o) => !o.is_member), [allOrgs]);

  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(dropdownRef, close);

  const resetManageDialog = useCallback(() => {
    setManagedOrg(null);
    setManageOrgName('');
    setManageOrgSlug('');
    setManageSlugTouched(false);
    setManageError(null);
    setIsSavingOrg(false);
    setIsDeletingOrg(false);
  }, []);

  const openManageDialog = useCallback((org: ApiOrganization) => {
    setManagedOrg(org);
    setManageOrgName(org.name);
    setManageOrgSlug(org.slug);
    setManageSlugTouched(true);
    setManageError(null);
    setIsSavingOrg(false);
    setIsDeletingOrg(false);
  }, []);

  const goToOwner = (slug: string) => {
    const target = buildOwnerHref(slug);
    if (target.kind === 'cross-host') {
      window.location.assign(target.href);
      return;
    }
    navigate({ to: target.to as '/' });
  };

  const handleOrgSwitch = async (orgId: string | null, slug?: string, isMember = true) => {
    if (session) {
      if (isMember && orgId) {
        await organization.setActive({ organizationId: orgId });
        if (slug) {
          goToOwner(slug);
        } else {
          navigate({ to: '/' });
        }
      } else if (slug) {
        goToOwner(slug);
      }
    } else if (slug) {
      goToOwner(slug);
    }
    setIsOpen(false);
  };

  const handleCreateOrg = async () => {
    setCreateError(null);
    if (!newOrgName.trim()) {
      setCreateError('Name is required');
      return;
    }
    setIsCreating(true);
    try {
      const slug = newOrgSlug.trim() || slugifyOrganizationName(newOrgName);
      const res = await organization.create({ name: newOrgName.trim(), slug });
      if (res.error) {
        setCreateError(res.error.message || 'Failed to create organization');
      } else {
        setShowCreateDialog(false);
        setNewOrgName('');
        setNewOrgSlug('');
        setSlugTouched(false);
        if (res.data) {
          await organization.setActive({ organizationId: res.data.id });
          goToOwner(res.data.slug);
        }
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveOrg = async () => {
    if (!managedOrg) return;

    const name = manageOrgName.trim();
    if (!name) {
      setManageError('Name is required');
      return;
    }

    const slug = manageOrgSlug.trim() || slugifyOrganizationName(name);
    if (!slug) {
      setManageError('Slug is required');
      return;
    }

    setIsSavingOrg(true);
    setManageError(null);

    try {
      const result = await organization.update({
        organizationId: managedOrg.id,
        data: { name, slug },
      });

      if (result.error) {
        setManageError(result.error.message || 'Failed to update organization');
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['organizations'] });

      const updatedOrg = result.data;
      const isCurrentOrg = activeOrg?.id === managedOrg.id || urlOrgSlug === managedOrg.slug;

      resetManageDialog();
      setIsOpen(false);

      if (updatedOrg && isCurrentOrg) {
        const subdomainOwner = getSubdomainOwner();
        const zone = getSubdomainZone();
        if (subdomainOwner === managedOrg.slug && zone) {
          // The current host *is* the renamed org's subdomain — hop to the new
          // host. window.location.pathname is normally already subdomain-
          // stripped, but a stale bookmark or pasted URL can carry the
          // redundant /${oldslug} prefix, so strip it before constructing the
          // cross-host URL — subdomain-history will re-prefix on the new host.
          const strippedPath =
            stripOwnerPrefix(window.location.pathname, managedOrg.slug) || '/';
          const target = `${window.location.protocol}//${updatedOrg.slug}.${zone}${strippedPath}${window.location.search}${window.location.hash}`;
          window.location.assign(target);
        } else {
          const nextPath = getRenamedOrganizationPath(
            window.location.pathname,
            managedOrg.slug,
            updatedOrg.slug
          );
          navigate({ to: `${nextPath}${window.location.search}${window.location.hash}` as '/' });
        }
      }
    } catch (e) {
      setManageError(e instanceof Error ? e.message : 'Failed to update organization');
    } finally {
      setIsSavingOrg(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!managedOrg) return;

    setIsDeletingOrg(true);
    setManageError(null);

    try {
      const result = await organization.delete({ organizationId: managedOrg.id });

      if (result.error) {
        setManageError(result.error.message || 'Failed to delete organization');
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['organizations'] });

      const fallbackOrg = memberOrgs.find((org) => org.id !== managedOrg.id) ?? null;
      const isCurrentOrg = activeOrg?.id === managedOrg.id || urlOrgSlug === managedOrg.slug;

      resetManageDialog();
      setIsOpen(false);

      if (isCurrentOrg && fallbackOrg) {
        await organization.setActive({ organizationId: fallbackOrg.id });
        goToOwner(fallbackOrg.slug);
      } else if (isCurrentOrg) {
        const subdomainOwner = getSubdomainOwner();
        const zone = getSubdomainZone();
        if (subdomainOwner === managedOrg.slug && zone) {
          // We just deleted the org whose subdomain we're currently on; bounce
          // off the dead host onto the canonical app origin.
          window.location.assign(`${window.location.protocol}//app.${zone}/`);
        } else {
          navigate({ to: '/' });
        }
      }
    } catch (e) {
      setManageError(e instanceof Error ? e.message : 'Failed to delete organization');
    } finally {
      setIsDeletingOrg(false);
    }
  };

  const { displayName, displayLogo, displayInitial } = resolveOrganizationDisplay({
    isAuthenticated,
    urlOrgSlug,
    activeOrg,
    sessionUser: session?.user,
    organizations: allOrgs || [],
  });

  return (
    <div className="relative flex-1 min-w-0" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1"
      >
        <div className="h-7 w-7 shrink-0 overflow-hidden rounded-lg bg-sidebar-foreground/10 flex items-center justify-center">
          {displayLogo ? (
            <img
              src={displayLogo}
              alt=""
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="text-sidebar-foreground text-sm font-semibold">
              {displayInitial.toUpperCase()}
            </span>
          )}
        </div>
        <span className="flex-1 truncate text-left font-semibold">{displayName}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 min-w-[240px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          <Command className="bg-transparent">
            <CommandInput placeholder="Search organizations..." className="h-9" />
            <CommandList className="max-h-[300px]">
              <CommandEmpty>No organizations found.</CommandEmpty>
              {isAuthenticated ? (
                <>
                  <CommandGroup heading="Your Organizations">
                    {memberOrgs.map((org) => (
                      <WorkspaceRow
                        key={org.id}
                        organization={org}
                        isActive={isOrganizationActive({
                          organization: org,
                          urlOrgSlug,
                          activeOrg,
                        })}
                        onSelect={() => handleOrgSwitch(org.id, org.slug)}
                        onManage={openManageDialog}
                      />
                    ))}
                  </CommandGroup>
                  {publicOnlyOrgs.length > 0 && (
                    <>
                      <CommandSeparator />
                      <CommandGroup heading="Public Organizations">
                        {publicOnlyOrgs.map((org) => (
                          <WorkspaceRow
                            key={org.id}
                            organization={org}
                            isActive={isOrganizationActive({
                              organization: org,
                              urlOrgSlug,
                              activeOrg,
                            })}
                            onSelect={() => handleOrgSwitch(org.id, org.slug, false)}
                          />
                        ))}
                      </CommandGroup>
                    </>
                  )}
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setIsOpen(false);
                        setShowCreateDialog(true);
                      }}
                      className="cursor-pointer text-muted-foreground"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      <span>Create Organization</span>
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : (
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      setIsOpen(false);
                      navigate({
                        to: '/auth/login',
                        search: {
                          callbackUrl: undefined,
                          mode: undefined,
                          error: undefined,
                          errorDescription: undefined,
                          loginHint: undefined,
                          invitationOrg: undefined,
                          intent: undefined,
                        },
                      });
                    }}
                    className="cursor-pointer text-muted-foreground"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    <span>Sign in to create organization</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </div>
      )}

      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateDialog(false);
            setCreateError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>
              Create a new organization to collaborate with others.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={newOrgName}
                onChange={(e) => {
                  setNewOrgName(e.target.value);
                  if (!slugTouched) {
                    setNewOrgSlug(slugifyOrganizationName(e.target.value));
                  }
                }}
                placeholder="e.g. My Team"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                value={newOrgSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setNewOrgSlug(e.target.value);
                }}
                placeholder="e.g. my-team"
              />
            </div>
            {createError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {createError}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowCreateDialog(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateOrg} disabled={isCreating}>
              {isCreating ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!managedOrg}
        onOpenChange={(open) => {
          if (!open) resetManageDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage Organization</DialogTitle>
            <DialogDescription>
              Rename or delete {managedOrg ? `"${managedOrg.name}"` : 'this organization'}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="manage-org-name">Name</Label>
              <Input
                id="manage-org-name"
                value={manageOrgName}
                onChange={(e) => {
                  setManageOrgName(e.target.value);
                  if (!manageSlugTouched) {
                    setManageOrgSlug(slugifyOrganizationName(e.target.value));
                  }
                }}
                placeholder="e.g. My Team"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="manage-org-slug">Slug</Label>
              <Input
                id="manage-org-slug"
                value={manageOrgSlug}
                onChange={(e) => {
                  setManageSlugTouched(true);
                  setManageOrgSlug(e.target.value);
                }}
                placeholder="e.g. my-team"
              />
            </div>

            <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-destructive/10 p-2 text-destructive">
                  <Trash2 className="h-4 w-4" />
                </div>
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium">Delete organization</p>
                    <p className="text-sm text-muted-foreground">
                      This permanently removes the organization and its workspace access.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDeleteOrg}
                    disabled={isSavingOrg || isDeletingOrg}
                  >
                    <Trash2 className="h-4 w-4" />
                    {isDeletingOrg ? 'Deleting...' : 'Delete Organization'}
                  </Button>
                </div>
              </div>
            </div>

            {manageError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {manageError}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={resetManageDialog}
              disabled={isSavingOrg || isDeletingOrg}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveOrg} disabled={isSavingOrg || isDeletingOrg}>
              <Pencil className="h-4 w-4" />
              {isSavingOrg ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
