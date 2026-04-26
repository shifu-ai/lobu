import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Link2,
  Loader2,
  Star,
  X,
  Zap,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { DynamicConnectorForm } from '@/components/entity-tabs/connections-tab/dynamic-connector-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExtendedContentItem } from '@/lib/api';
import { useApproveRun, useRejectRun } from '@/lib/api/connections';
import { formatTimeAgo } from '@/lib/format-utils';
import type { JsonNode } from '@/lib/json-renderer';
import { JsonRenderer } from '@/lib/json-renderer';

interface EventCardProps {
  content: ExtendedContentItem;
  isReply?: boolean;
  showParentContext?: boolean;
}

function sentenceCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function renderMetadataValue(value: unknown): ReactNode {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.every((item) => typeof item !== 'object') ? (
      value.map((item) => String(item)).join(', ')
    ) : (
      <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-lg font-semibold mt-4 mb-1">{children}</h2>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-base font-semibold mt-3 mb-1">{children}</h3>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-sm text-foreground leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc list-inside space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="list-decimal list-inside space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="text-sm text-muted-foreground">{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline"
    >
      {children}
    </a>
  ),
};

function getVisibleMetadataEntries(metadata: Record<string, unknown>) {
  return Object.entries(metadata)
    .filter(([, value]) => {
      if (value == null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object')
        return Object.keys(value as Record<string, unknown>).length > 0;
      return true;
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

function ScoreBreakdown({ breakdown }: { breakdown: ExtendedContentItem['score_breakdown'] }) {
  if (!breakdown) return null;

  const items = [
    { label: 'Engagement', value: breakdown.engagement, max: 100 },
    { label: 'Criticality', value: breakdown.criticality, max: 100 },
    { label: 'Depth', value: breakdown.depth, max: 100 },
    { label: 'Authority', value: breakdown.authority, max: 100 },
    { label: 'Recency', value: breakdown.recency, max: 100 },
    { label: 'Quality', value: breakdown.quality, max: 100 },
  ];

  return (
    <div className="space-y-2 text-sm">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground">{item.label}</span>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary"
              style={{ width: `${(item.value / item.max) * 100}%` }}
            />
          </div>
          <span className="w-8 text-right">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function ClassificationBadge({
  slug,
  value,
  isManual,
}: {
  slug: string;
  value: string;
  isManual?: boolean;
}) {
  return (
    <Badge variant="secondary" className="text-xs">
      {slug}: {value}
      {isManual && <Star className="ml-1 h-2.5 w-2.5 fill-current" />}
    </Badge>
  );
}

function normalizeClassificationValues(data: unknown): { values: string[]; isManual: boolean } {
  if (data && typeof data === 'object') {
    const valueObj = data as {
      value?: unknown;
      values?: unknown;
      is_manual?: unknown;
    };

    if (Array.isArray(valueObj.values)) {
      return {
        values: valueObj.values.map((v) => String(v)).filter((v) => v.length > 0),
        isManual: valueObj.is_manual === true,
      };
    }

    if (valueObj.value !== undefined && valueObj.value !== null) {
      return {
        values: [String(valueObj.value)],
        isManual: valueObj.is_manual === true,
      };
    }

    if (typeof valueObj.values === 'string' && valueObj.values.length > 0) {
      return {
        values: [valueObj.values],
        isManual: valueObj.is_manual === true,
      };
    }
  }

  if (
    typeof data === 'string' ||
    typeof data === 'number' ||
    typeof data === 'boolean' ||
    typeof data === 'bigint'
  ) {
    return { values: [String(data)], isManual: false };
  }

  return { values: [], isManual: false };
}

function mapInteractionStatus(
  interactionStatus: string | null | undefined,
  legacyStatus: string | undefined
): string {
  if (interactionStatus) {
    switch (interactionStatus) {
      case 'pending':
        return 'pending_approval';
      case 'approved':
        return 'confirmed';
      case 'rejected':
        return 'rejected';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return interactionStatus;
    }
  }
  return legacyStatus || 'pending_approval';
}

function ActionApprovalCard({ content }: { content: ExtendedContentItem }) {
  const metadata = (content.metadata || {}) as Record<string, unknown>;
  const runId = metadata.run_id as number | undefined;
  const actionName =
    (metadata.operation_name as string) ||
    (metadata.action_name as string) ||
    content.title ||
    'Action';
  const connectionName = metadata.connection_name as string | undefined;

  const inputSchema =
    content.interaction_input_schema || (metadata.input_schema as Record<string, unknown>) || null;
  const actionInput = (content.interaction_input ||
    (metadata.action_input as Record<string, unknown>) ||
    (metadata.operation_input as Record<string, unknown>) ||
    {}) as Record<string, unknown>;
  const actionOutput =
    content.interaction_output || (metadata.action_output as Record<string, unknown>) || undefined;
  const errorMessage = content.interaction_error || (metadata.error_message as string) || undefined;
  const status = mapInteractionStatus(
    content.interaction_status,
    metadata.status as string | undefined
  );

  const approveRun = useApproveRun();
  const rejectRun = useRejectRun();
  const [formValues, setFormValues] = useState<Record<string, unknown>>(actionInput);
  useEffect(() => {
    setFormValues(actionInput);
  }, [actionInput]);
  const [resolved, setResolved] = useState<'confirmed' | 'rejected' | null>(null);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const handleInputChange = useCallback((values: Record<string, unknown>) => {
    setFormValues(values);
  }, []);

  const isPending = status === 'pending_approval';

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-yellow-500" />
          <span className="font-medium">{actionName}</span>
          {connectionName && (
            <span className="text-xs text-muted-foreground">on {connectionName}</span>
          )}
          {isPending && (
            <Badge
              variant="outline"
              className="text-yellow-700 border-yellow-300 bg-yellow-50 dark:bg-yellow-950/30 text-[10px]"
            >
              Pending Approval
            </Badge>
          )}
          {status === 'confirmed' && (
            <Badge
              variant="outline"
              className="text-blue-700 border-blue-300 bg-blue-50 dark:bg-blue-950/30 text-[10px]"
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin mr-1" />
              Executing
            </Badge>
          )}
          {status === 'completed' && (
            <Badge
              variant="outline"
              className="text-green-700 border-green-300 bg-green-50 dark:bg-green-950/30 text-[10px]"
            >
              Completed
            </Badge>
          )}
          {status === 'failed' && (
            <Badge
              variant="outline"
              className="text-red-700 border-red-300 bg-red-50 dark:bg-red-950/30 text-[10px]"
            >
              Failed
            </Badge>
          )}
          {status === 'rejected' && (
            <Badge variant="outline" className="text-muted-foreground text-[10px]">
              Rejected
            </Badge>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {content.author_name && <span>Requested by {content.author_name}</span>}
          {content.occurred_at && <span> · {formatTimeAgo(content.occurred_at)}</span>}
        </div>

        {/* Action form — editable when pending, read-only otherwise */}
        {inputSchema && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Input</p>
            {isPending ? (
              <DynamicConnectorForm
                key={`action-${content.id}`}
                schema={inputSchema}
                initialValues={actionInput}
                onValuesChange={handleInputChange}
                fieldIdPrefix={`action-${content.id}-`}
              />
            ) : (
              <pre className="text-xs bg-muted/50 rounded p-2 font-mono overflow-auto max-h-32">
                {JSON.stringify(actionInput, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Output */}
        {status === 'completed' && actionOutput && Object.keys(actionOutput).length > 0 && (
          <div className="rounded-md bg-green-50 dark:bg-green-950/30 p-3 text-sm space-y-1">
            <div className="flex items-center gap-1.5 text-green-700 dark:text-green-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Output
            </div>
            <pre className="text-xs text-green-800 dark:text-green-300 font-mono whitespace-pre-wrap">
              {JSON.stringify(actionOutput, null, 2)}
            </pre>
          </div>
        )}

        {/* Error */}
        {status === 'failed' && errorMessage && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm">
            <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-medium">
              <AlertCircle className="h-3.5 w-3.5" />
              Error
            </div>
            <p className="text-xs text-red-800 dark:text-red-300 font-mono mt-1">{errorMessage}</p>
          </div>
        )}

        {/* Resolved state (shown after approve/reject) */}
        {resolved === 'confirmed' && (
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 p-3 text-sm">
            <div className="flex items-center gap-1.5 text-blue-700 dark:text-blue-400 font-medium">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Confirmed — executing...
            </div>
            <p className="text-xs text-blue-800 dark:text-blue-300 mt-1">
              The worker will execute this action shortly. Redirecting...
            </p>
          </div>
        )}
        {resolved === 'rejected' && (
          <Badge variant="outline" className="text-muted-foreground text-xs">
            Rejected — redirecting...
          </Badge>
        )}

        {/* Approve / Reject buttons */}
        {isPending && runId && !resolved && (
          <div className="flex items-center gap-2 pt-1">
            {!showRejectInput ? (
              <>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    approveRun.mutate(
                      { run_id: runId, input: formValues },
                      {
                        onSuccess: (data) => {
                          setResolved('confirmed');
                          if (data.event_id) {
                            const url = new URL(window.location.href);
                            url.searchParams.set('content_ids', String(data.event_id));
                            setTimeout(() => window.location.replace(url.toString()), 1500);
                          }
                        },
                      }
                    )
                  }
                  disabled={approveRun.isPending || rejectRun.isPending}
                >
                  {approveRun.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Check className="h-3 w-3 mr-1" />
                  )}
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setShowRejectInput(true)}
                  disabled={approveRun.isPending || rejectRun.isPending}
                >
                  <X className="h-3 w-3 mr-1" />
                  Reject
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2 w-full">
                <input
                  type="text"
                  placeholder="Reason (optional)"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="h-7 text-xs border rounded px-2 flex-1 bg-background"
                />
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  onClick={() =>
                    rejectRun.mutate(
                      { run_id: runId, reason: rejectReason || undefined },
                      {
                        onSuccess: (data) => {
                          setResolved('rejected');
                          if (data.event_id) {
                            const url = new URL(window.location.href);
                            url.searchParams.set('content_ids', String(data.event_id));
                            setTimeout(() => window.location.replace(url.toString()), 1500);
                          }
                        },
                      }
                    )
                  }
                  disabled={rejectRun.isPending}
                >
                  {rejectRun.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  Confirm Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  onClick={() => {
                    setShowRejectInput(false);
                    setRejectReason('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function EventCard({ content, isReply, showParentContext }: EventCardProps) {
  const [showFullText, setShowFullText] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const metadata = (content.metadata || {}) as Record<string, unknown>;
  const isOperationEvent =
    content.interaction_type === 'approval' ||
    content.semantic_type === 'operation' ||
    metadata.status != null ||
    metadata.action_key != null;

  // Action events get a dedicated approval UI
  if (isOperationEvent) {
    return <ActionApprovalCard content={content} />;
  }

  const roundedScore = Number.isFinite(content.score) ? Math.round(content.score) : '-';

  const payloadType = content.payload_type || 'text';
  const textContent = content.text_content || '';
  const shouldTruncate =
    (payloadType === 'text' || payloadType === 'markdown') && textContent.length > 500;
  const displayText =
    shouldTruncate && !showFullText ? `${textContent.slice(0, 500)}...` : textContent;

  // Well-known metadata fields (declared via eventKinds.metadataSchema)
  const thumbnail =
    (metadata.thumbnail_url as string | undefined) || (metadata.thumbnail as string | undefined);
  const mediaUrl = metadata.media_url as string | undefined;
  const metadataEntries = getVisibleMetadataEntries(metadata);

  // Parse classifications
  const classifications = Object.entries(content.classifications || {}).flatMap(([slug, data]) => {
    const parsed = normalizeClassificationValues(data);
    return parsed.values.map((value) => ({
      slug,
      value,
      isManual: parsed.isManual,
    }));
  });

  return (
    <Card className={isReply ? 'ml-6 border-l-2 border-l-muted' : ''}>
      <CardContent className="pt-4">
        {/* Parent context for orphaned replies */}
        {showParentContext && content.parent_context && (
          <div className="mb-3 p-2 bg-muted/50 rounded-md text-sm">
            <div className="text-xs text-muted-foreground mb-1">Replying to:</div>
            <div className="font-medium">{content.parent_context.author_name}</div>
            <div className="text-muted-foreground line-clamp-2">
              {content.parent_context.text_content}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-2">
          <div className="flex-1 min-w-0">
            {content.title && <h4 className="font-medium line-clamp-2 mb-1">{content.title}</h4>}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium">{content.author_name || 'Unknown'}</span>
              <span>·</span>
              <span>{formatTimeAgo(content.occurred_at)}</span>
              {content.platform && (
                <>
                  <span>·</span>
                  <Badge variant="outline" className="text-xs">
                    {content.platform}
                  </Badge>
                </>
              )}
            </div>
          </div>

          {/* Score */}
          <div className="flex items-center gap-2">
            {content.score_breakdown ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2">
                    <span className="font-medium">{roundedScore}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64" align="end">
                  <div className="space-y-2">
                    <h4 className="font-medium">Score Breakdown</h4>
                    <ScoreBreakdown breakdown={content.score_breakdown} />
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 px-2" disabled>
                <span className="font-medium">{roundedScore}</span>
              </Button>
            )}

            {content.permalink && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      const url = content.permalink!.startsWith('http')
                        ? content.permalink!
                        : `${window.location.origin}${content.permalink}`;
                      navigator.clipboard.writeText(url);
                      clearTimeout(copyTimeoutRef.current);
                      setCopied(true);
                      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Link2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? 'Copied!' : 'Copy permalink'}</TooltipContent>
              </Tooltip>
            )}

            {content.source_url && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                    <a href={content.source_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View original</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Rating */}
        {content.rating && (
          <div className="flex items-center gap-1 mb-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <Star
                key={star}
                className={`h-4 w-4 ${
                  star <= Number(content.rating)
                    ? 'fill-yellow-400 text-yellow-400'
                    : 'text-muted-foreground'
                }`}
              />
            ))}
          </div>
        )}

        {/* Thumbnail / media preview */}
        {thumbnail && (
          <a
            href={mediaUrl || content.source_url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="block mb-2"
          >
            <img
              src={thumbnail}
              alt=""
              className={`rounded-md object-cover ${payloadType === 'media' ? 'max-h-96 w-full' : 'max-h-48'}`}
              loading="lazy"
            />
          </a>
        )}

        {/* Classification evidence excerpt */}
        {content.excerpt && (
          <div className="text-sm italic text-muted-foreground border-l-2 border-primary/40 pl-2 mb-1">
            {content.excerpt}
          </div>
        )}

        {/* Content */}
        {(() => {
          switch (payloadType) {
            case 'markdown':
              if (displayText) {
                return (
                  <div className="max-w-none text-sm space-y-2">
                    <ReactMarkdown components={markdownComponents}>{displayText}</ReactMarkdown>
                  </div>
                );
              }
              break;

            case 'json_template': {
              const tmpl = content.payload_template as { root: JsonNode } | null;
              if (tmpl?.root) {
                return (
                  <JsonRenderer
                    template={{ root: tmpl.root }}
                    data={(content.payload_data as Record<string, unknown>) || {}}
                  />
                );
              }
              if (displayText) {
                return <div className="text-sm whitespace-pre-wrap">{displayText}</div>;
              }
              break;
            }

            case 'media':
              return (
                <div className="space-y-3">
                  {!thumbnail && mediaUrl && (
                    <a
                      href={mediaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline truncate block"
                    >
                      {mediaUrl}
                    </a>
                  )}
                  {displayText && (
                    <div className="text-sm whitespace-pre-wrap text-muted-foreground">
                      {displayText}
                    </div>
                  )}
                </div>
              );

            case 'empty':
              return (
                <div className="space-y-3">
                  {metadataEntries.length > 0 ? (
                    <dl className="grid gap-x-3 gap-y-2 text-sm sm:grid-cols-[minmax(140px,180px)_1fr]">
                      {metadataEntries.map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{sentenceCase(key)}</dt>
                          <dd className="min-w-0 break-words font-mono text-xs sm:text-sm">
                            {renderMetadataValue(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No content</p>
                  )}
                </div>
              );

            case 'text':
            default:
              if (displayText) {
                return <div className="text-sm whitespace-pre-wrap">{displayText}</div>;
              }
              break;
          }

          // Fallback: metadata grid + media URL
          return (
            <div className="space-y-3">
              {mediaUrl && !thumbnail && (
                <a
                  href={mediaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-foreground truncate block"
                >
                  {mediaUrl}
                </a>
              )}
              {metadataEntries.length > 0 && (
                <dl className="grid gap-x-3 gap-y-2 text-sm sm:grid-cols-[minmax(140px,180px)_1fr]">
                  {metadataEntries.map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{sentenceCase(key)}</dt>
                      <dd className="min-w-0 break-words font-mono text-xs sm:text-sm">
                        {renderMetadataValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })()}

        {shouldTruncate && (
          <Button
            variant="link"
            size="sm"
            className="px-0 h-6 mt-1"
            onClick={() => setShowFullText(!showFullText)}
          >
            {showFullText ? (
              <>
                <ChevronUp className="h-3 w-3 mr-1" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3 mr-1" /> Show more
              </>
            )}
          </Button>
        )}

        {/* Classifications */}
        {classifications.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {classifications.map((c) => (
              <ClassificationBadge
                key={c.slug}
                slug={c.slug}
                value={c.value || ''}
                isManual={c.isManual}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
