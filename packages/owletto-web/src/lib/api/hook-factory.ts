import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type ApiOrgContext, apiCall, normalizeOrgContext, resolveOrgSelector } from './core';

type NormalizedCtx = { organizationId: string | null; slug: string | null };
type OrgContextParam = ApiOrgContext | string | null | undefined;

// ---------------------------------------------------------------------------
// Query factory for hooks that call apiCall with org-context resolution.
//
// The caller-facing argument tuple is TArgs (which includes the orgContext
// parameter at whatever position the original hook had it). The config
// receives the full TArgs tuple and is responsible for pulling out
// orgContext and building the body / queryKey.
// ---------------------------------------------------------------------------

export function createOrgQuery<TArgs extends readonly unknown[], TResult>(config: {
  queryKey: (ctx: NormalizedCtx, ...args: TArgs) => unknown[];
  tool: string;
  body: (...args: TArgs) => Record<string, unknown>;
  orgContext: (...args: TArgs) => OrgContextParam;
  transform?: (data: any) => TResult;
  enabled?: (ctx: NormalizedCtx, ...args: TArgs) => boolean;
  placeholderData?: (ctx: NormalizedCtx, ...args: TArgs) => TResult | undefined;
  staleTime?: number;
}) {
  return (...args: TArgs) => {
    const ctx = normalizeOrgContext(config.orgContext(...args));
    const hasContext = !!(ctx.organizationId || ctx.slug);

    return useQuery({
      queryKey: config.queryKey(ctx, ...args),
      queryFn: async () => {
        const result = await apiCall<any>(
          config.tool,
          config.body(...args),
          resolveOrgSelector(ctx)
        );
        return config.transform ? config.transform(result) : (result as TResult);
      },
      enabled: config.enabled?.(ctx, ...args) ?? hasContext,
      placeholderData: config.placeholderData?.(ctx, ...args) as never,
      staleTime: config.staleTime,
    });
  };
}

// ---------------------------------------------------------------------------
// Query factory for hooks that call apiCall WITHOUT org-context
// ---------------------------------------------------------------------------

export function createQuery<TArgs extends readonly unknown[], TResult>(config: {
  queryKey: (...args: TArgs) => unknown[];
  tool: string;
  body: (...args: TArgs) => Record<string, unknown>;
  transform?: (data: any) => TResult;
  enabled?: (...args: TArgs) => boolean;
  staleTime?: number;
}) {
  return (...args: TArgs) => {
    return useQuery({
      queryKey: config.queryKey(...args),
      queryFn: async () => {
        const result = await apiCall<any>(config.tool, config.body(...args));
        return config.transform ? config.transform(result) : (result as TResult);
      },
      enabled: config.enabled?.(...args) ?? true,
      staleTime: config.staleTime,
    });
  };
}

// ---------------------------------------------------------------------------
// Mutation factory
// ---------------------------------------------------------------------------

export function createMutation<TParams, TResult = unknown>(config: {
  tool: string;
  body: (params: TParams) => Record<string, unknown>;
  invalidateKeys: string[];
  transform?: (data: any) => TResult;
  checkError?: boolean; // default true -- throw if result.error exists
  successMessage?: string;
}) {
  return () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: async (params: TParams) => {
        const result = await apiCall<any>(config.tool, config.body(params));
        if (config.checkError !== false && result.error) {
          throw new Error(result.error);
        }
        return config.transform ? config.transform(result) : (result as TResult);
      },
      onSuccess: () => {
        for (const key of config.invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
        if (config.successMessage) {
          toast.success(config.successMessage);
        }
      },
      onError: (error: Error) => {
        toast.error(error.message || 'Something went wrong');
      },
    });
  };
}
