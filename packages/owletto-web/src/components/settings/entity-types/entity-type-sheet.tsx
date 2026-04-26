import { AlertTriangle, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { OrgContext } from '@/hooks/use-org-context';
import { type EntityTypeAdmin, useDeleteEntityType, useEntityTypeAudit } from '@/lib/api';
import { AuditEntryItem } from './entity-type-audit-entries';
import { EntityTypeForm } from './entity-type-form';

interface EntityTypeSheetProps {
  entityType: EntityTypeAdmin | null; // null = create mode
  onClose: () => void;
  orgContext: OrgContext;
}

export function EntityTypeSheet({ entityType, onClose, orgContext }: EntityTypeSheetProps) {
  const isEditing = !!entityType;
  const [showAudit, setShowAudit] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteMutation = useDeleteEntityType();

  const { data: auditEntries, isLoading: isAuditLoading } = useEntityTypeAudit(
    showAudit && entityType ? entityType.slug : null,
    orgContext
  );

  const entityCount = entityType?.entity_count ?? 0;
  const hasEntities = entityCount > 0;

  const handleDelete = async () => {
    if (!entityType) return;
    setDeleteError(null);

    try {
      await deleteMutation.mutateAsync(entityType.slug);
      onClose();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {isEditing ? (
            <>
              {entityType.icon || '📄'} {entityType.name}
            </>
          ) : (
            'Create Entity Type'
          )}
        </SheetTitle>
        <SheetDescription>
          {isEditing
            ? 'Edit entity type configuration.'
            : 'Define a new entity type for your workspace.'}
        </SheetDescription>
      </SheetHeader>

      <div className="py-4">
        <EntityTypeForm entityType={entityType} onCancel={onClose} onSaved={onClose} />
      </div>

      {isEditing && (
        <>
          {/* Collapsible audit history */}
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowAudit(!showAudit)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              {showAudit ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              History
            </button>

            {showAudit && (
              <div className="mt-3">
                {isAuditLoading ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Loading history...
                  </p>
                ) : auditEntries && auditEntries.length > 0 ? (
                  <div className="relative ml-1.5">
                    {auditEntries.map((entry) => (
                      <AuditEntryItem key={entry.id} entry={entry} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No audit history found.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Delete section */}
          <div className="border-t border-border pt-4 mt-4">
            {!confirmingDelete ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete entity type
              </Button>
            ) : (
              <div className="space-y-3">
                {hasEntities ? (
                  <div className="flex items-start gap-3 p-3 rounded-md bg-amber-500/10 text-amber-600">
                    <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-medium">Cannot delete this entity type</p>
                      <p className="mt-1 text-amber-600/80">
                        There {entityCount === 1 ? 'is' : 'are'} {entityCount} entit
                        {entityCount === 1 ? 'y' : 'ies'} of type "{entityType.name}". Migrate or
                        delete them first.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Are you sure you want to delete "{entityType.name}"? This action will
                    soft-delete the entity type. It can be restored by a database administrator.
                  </p>
                )}

                {deleteError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {deleteError}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setConfirmingDelete(false);
                      setDeleteError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={hasEntities || deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
