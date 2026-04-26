import type { AuthArtifact } from '@lobu/owletto-sdk';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSendAuthSignal } from '@/lib/api/connections';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const expiryMs = new Date(expiresAt).getTime();
  const remainingMs = expiryMs - now;
  const expired = remainingMs <= 0;
  return (
    <span className={`text-xs font-mono ${expired ? 'text-destructive' : 'text-muted-foreground'}`}>
      {expired ? 'Expired — waiting for refresh…' : `Expires in ${formatRemaining(remainingMs)}`}
    </span>
  );
}

function QrArtifact({ artifact }: { artifact: Extract<AuthArtifact, { type: 'qr' }> }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <div className="rounded-md bg-white p-3 border">
          <QRCodeSVG value={artifact.value} size={220} level="M" />
        </div>
      </div>
      {artifact.expiresAt && (
        <div className="flex justify-center">
          <ExpiryCountdown expiresAt={artifact.expiresAt} />
        </div>
      )}
      {artifact.instructions && (
        <p className="text-sm text-muted-foreground text-center">{artifact.instructions}</p>
      )}
    </div>
  );
}

function CodeArtifact({ artifact }: { artifact: Extract<AuthArtifact, { type: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(artifact.value.replace(/[^A-Za-z0-9]/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [artifact.value]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-center gap-2">
        <code className="font-mono text-2xl tracking-widest px-4 py-2 rounded bg-muted border">
          {artifact.value}
        </code>
        <Button variant="outline" size="sm" onClick={() => void onCopy()}>
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy
            </>
          )}
        </Button>
      </div>
      {artifact.expiresAt && (
        <div className="flex justify-center">
          <ExpiryCountdown expiresAt={artifact.expiresAt} />
        </div>
      )}
      {artifact.instructions && (
        <p className="text-sm text-muted-foreground text-center">{artifact.instructions}</p>
      )}
    </div>
  );
}

function RedirectArtifact({
  artifact,
  runId,
}: {
  artifact: Extract<AuthArtifact, { type: 'redirect' }>;
  runId: number;
}) {
  const sendSignal = useSendAuthSignal();
  const [opened, setOpened] = useState(false);

  const handleOpen = useCallback(() => {
    if (artifact.mode === 'popup') {
      window.open(artifact.url, '_blank', 'noopener,noreferrer,width=600,height=700');
    } else {
      window.location.href = artifact.url;
    }
    setOpened(true);
  }, [artifact.mode, artifact.url]);

  const handleReturned = useCallback(() => {
    void sendSignal.mutateAsync({ run_id: runId, name: artifact.awaitSignal, payload: {} });
  }, [sendSignal, runId, artifact.awaitSignal]);

  return (
    <div className="space-y-3">
      {artifact.instructions && (
        <p className="text-sm text-muted-foreground">{artifact.instructions}</p>
      )}
      <div className="flex flex-col items-stretch gap-2">
        <Button onClick={handleOpen}>
          <ExternalLink className="h-4 w-4 mr-2" />
          {opened ? 'Re-open authorization page' : 'Open authorization page'}
        </Button>
        {opened && (
          <Button variant="outline" onClick={handleReturned} disabled={sendSignal.isPending}>
            {sendSignal.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Notifying…
              </>
            ) : (
              'I have completed authorization'
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function PromptArtifact({
  artifact,
  runId,
}: {
  artifact: Extract<AuthArtifact, { type: 'prompt' }>;
  runId: number;
}) {
  const sendSignal = useSendAuthSignal();
  const [values, setValues] = useState<Record<string, string>>({});

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void sendSignal.mutateAsync({
        run_id: runId,
        name: artifact.submitSignal,
        payload: values,
      });
    },
    [sendSignal, runId, artifact.submitSignal, values]
  );

  const canSubmit = artifact.fields.every(
    (f) => !f.required || (values[f.key] ?? '').trim().length > 0
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {artifact.instructions && (
        <p className="text-sm text-muted-foreground">{artifact.instructions}</p>
      )}
      {artifact.fields.map((field) => (
        <div key={field.key} className="space-y-1">
          <label htmlFor={`auth-field-${field.key}`} className="text-xs font-medium">
            {field.label}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </label>
          <Input
            id={`auth-field-${field.key}`}
            type={field.kind === 'password' ? 'password' : 'text'}
            inputMode={field.kind === 'otp' ? 'numeric' : undefined}
            autoComplete={field.kind === 'otp' ? 'one-time-code' : undefined}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
          />
        </div>
      ))}
      <Button type="submit" disabled={!canSubmit || sendSignal.isPending} className="w-full">
        {sendSignal.isPending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…
          </>
        ) : (
          'Submit'
        )}
      </Button>
    </form>
  );
}

function StatusArtifact({ artifact }: { artifact: Extract<AuthArtifact, { type: 'status' }> }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{artifact.message}</span>
    </div>
  );
}

export function ArtifactRenderer({ artifact, runId }: { artifact: AuthArtifact; runId: number }) {
  switch (artifact.type) {
    case 'qr':
      return <QrArtifact artifact={artifact} />;
    case 'code':
      return <CodeArtifact artifact={artifact} />;
    case 'redirect':
      return <RedirectArtifact artifact={artifact} runId={runId} />;
    case 'prompt':
      return <PromptArtifact artifact={artifact} runId={runId} />;
    case 'status':
      return <StatusArtifact artifact={artifact} />;
  }
}
