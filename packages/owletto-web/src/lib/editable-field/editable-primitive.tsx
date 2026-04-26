import { Check, Pencil, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFieldFeedback } from './context';

/**
 * Past correction applied to a single field. When supplied, the editable
 * primitive shows the corrected value as the active display and exposes the
 * original LLM output via a tooltip so reviewers can audit the change.
 */
export interface FieldCorrection {
  value: unknown;
  note?: string | null;
  author?: string | null;
  createdAt?: string | null;
  mutation?: 'set' | 'remove' | 'add';
}

interface EditablePrimitiveProps {
  value: unknown;
  fieldPath: string;
  onCorrection: (fieldPath: string, newValue: unknown) => void;
  /** Latest already-submitted correction for this field, if any. */
  correction?: FieldCorrection;
  /** A value the user has staged but not yet submitted. */
  pending?: unknown;
}

function formatDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Editable primitive value: shows pencil on hover, inline edit on click,
 * Enter to commit, Esc to cancel. If `correction` is set, the corrected
 * value is displayed in place of the original and an "edited" badge with a
 * tooltip exposes the prior value, note, and author.
 */
export function EditablePrimitive({
  value,
  fieldPath,
  onCorrection,
  correction: correctionProp,
  pending: pendingProp,
}: EditablePrimitiveProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Direct props win over context. Context is the normal path; props are an
  // escape hatch for non-context call sites.
  const fromContext = useFieldFeedback(fieldPath);
  const correction = correctionProp ?? fromContext.correction;
  const pending = pendingProp !== undefined ? pendingProp : fromContext.pending;

  const hasPending = pending !== undefined;
  const hasCorrection = correction !== undefined;
  // Display priority: pending edit > committed correction > original value.
  const displayValue = hasPending ? pending : hasCorrection ? correction.value : value;

  const startEdit = useCallback(() => {
    setEditValue(formatDisplay(displayValue));
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [displayValue]);

  const commit = useCallback(() => {
    setEditing(false);
    const strVal = editValue.trim();
    let newValue: unknown = strVal;
    // Coerce back to the original primitive type so numbers stay numeric.
    if (typeof value === 'number') {
      const num = Number(strVal);
      if (!Number.isNaN(num)) newValue = num;
    } else if (typeof value === 'boolean') {
      newValue = strVal.toLowerCase() === 'true';
    }
    if (newValue !== displayValue) {
      onCorrection(fieldPath, newValue);
    }
  }, [editValue, value, displayValue, fieldPath, onCorrection]);

  const cancel = useCallback(() => setEditing(false), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        cancel();
      }
    },
    [commit, cancel]
  );

  if (editing) {
    const isLong = typeof value === 'string' && String(value).length > 80;
    return (
      <span className="inline-flex items-center gap-1">
        {isLong ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className="min-w-[200px] rounded border border-primary bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-w-[100px] rounded border border-primary bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        <button
          type="button"
          onClick={commit}
          className="rounded p-0.5 text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={cancel}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  const indicatorTone = hasPending
    ? 'text-amber-600 dark:text-amber-400'
    : hasCorrection
      ? 'text-emerald-600 dark:text-emerald-400'
      : '';

  const display = (
    <button
      type="button"
      className={`inline-flex items-center gap-1 group/edit hover:bg-muted/40 rounded px-0.5 text-left ${indicatorTone}`}
      onClick={startEdit}
    >
      <span className="whitespace-pre-wrap">{formatDisplay(displayValue) || '—'}</span>
      {hasPending ? (
        <span className="text-[10px] uppercase tracking-wide opacity-70">unsubmitted</span>
      ) : null}
      <Pencil className="h-3 w-3 opacity-0 group-hover/edit:opacity-50" />
    </button>
  );

  if (!hasCorrection || hasPending) {
    return display;
  }

  // Render the corrected value with a tooltip that exposes the original output.
  const original = formatDisplay(value);
  const noteLine = correction.note ? `Note: ${correction.note}` : null;
  const meta = [correction.author, correction.createdAt].filter(Boolean).join(' · ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1">
          {display}
          <span className="text-[10px] uppercase tracking-wide rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 text-emerald-600 dark:text-emerald-400">
            edited
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1">
        <div className="text-xs">
          <span className="text-muted-foreground">Original: </span>
          <span className="font-mono">{original || '—'}</span>
        </div>
        {noteLine ? <div className="text-xs">{noteLine}</div> : null}
        {meta ? <div className="text-[11px] text-muted-foreground">{meta}</div> : null}
      </TooltipContent>
    </Tooltip>
  );
}
