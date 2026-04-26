import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { FieldCorrection } from './editable-primitive';

interface FieldFeedbackContextValue {
  /** Latest committed correction per field path (most recent wins). */
  corrections: Record<string, FieldCorrection>;
  /** Locally staged but not yet submitted overrides per field path. */
  pendingCorrections: Record<string, unknown>;
}

const FieldFeedbackContext = createContext<FieldFeedbackContextValue | undefined>(undefined);

interface FieldFeedbackProviderProps {
  corrections?: Record<string, FieldCorrection>;
  pendingCorrections?: Record<string, unknown>;
  children: ReactNode;
}

export function FieldFeedbackProvider({
  corrections,
  pendingCorrections,
  children,
}: FieldFeedbackProviderProps) {
  const value = useMemo<FieldFeedbackContextValue>(
    () => ({
      corrections: corrections ?? {},
      pendingCorrections: pendingCorrections ?? {},
    }),
    [corrections, pendingCorrections]
  );
  return <FieldFeedbackContext.Provider value={value}>{children}</FieldFeedbackContext.Provider>;
}

export function useFieldFeedback(fieldPath: string | undefined): {
  correction?: FieldCorrection;
  pending?: unknown;
} {
  const ctx = useContext(FieldFeedbackContext);
  if (!ctx || !fieldPath) return {};
  const correction = ctx.corrections[fieldPath];
  const pending = ctx.pendingCorrections[fieldPath];
  return {
    correction,
    pending: fieldPath in ctx.pendingCorrections ? pending : undefined,
  };
}
