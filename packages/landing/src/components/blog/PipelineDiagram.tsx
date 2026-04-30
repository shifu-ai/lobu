type PipelineStep = {
  emoji?: string;
  title: string;
  detail?: string;
};

type PipelineDiagramProps = {
  title?: string;
  steps: PipelineStep[];
};

export function PipelineDiagram({ title, steps }: PipelineDiagramProps) {
  return (
    <div class="my-8 rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-surface-dim)] p-4 sm:p-5">
      {title && (
        <div class="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-page-text-muted)]">
          {title}
        </div>
      )}
      <div class="flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <div key={step.title} class="contents">
            <div class="rounded-lg border border-[var(--color-page-border)] bg-[var(--color-page-bg)] px-3 py-2.5 sm:px-4 sm:py-3">
              <div class="grid gap-1.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-3">
                <div>
                  <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
                    Step {index + 1}
                  </div>
                  <div class="mt-0.5 flex items-start gap-2 text-[0.98rem] font-semibold leading-tight text-[var(--color-page-text)] sm:text-[1rem]">
                    {step.emoji && <span aria-hidden="true">{step.emoji}</span>}
                    <span>{step.title}</span>
                  </div>
                </div>
                {step.detail && (
                  <div class="text-[0.92rem] leading-6 text-[var(--color-page-text-muted)] sm:self-center">
                    {step.detail}
                  </div>
                )}
              </div>
            </div>
            {index < steps.length - 1 && (
              <div
                aria-hidden="true"
                class="flex items-center justify-center py-0.5 text-base text-[var(--color-tg-accent)]"
              >
                ↓
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
