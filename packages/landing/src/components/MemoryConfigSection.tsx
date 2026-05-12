import type { ComponentChildren } from "preact";
import type { LandingUseCaseShowcase } from "../use-case-showcases";

function Tile({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div class="rounded-2xl border border-[var(--color-page-border)] bg-white p-5 shadow-[0_18px_55px_rgba(16,24,40,0.04)]">
      <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
        {eyebrow}
      </div>
      <h3 class="mt-2 text-lg font-semibold text-[var(--color-page-text)]">
        {title}
      </h3>
      <p class="mt-3 text-sm leading-6 text-[var(--color-page-text-muted)]">
        {children}
      </p>
    </div>
  );
}

function Step({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div class="flex gap-3 rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4">
      <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-orange-50 text-xs font-semibold text-orange-700">
        {index}
      </span>
      <div>
        <div class="text-sm font-semibold text-[var(--color-page-text)]">
          {title}
        </div>
        <div class="mt-1 text-xs leading-5 text-[var(--color-page-text-muted)]">
          {body}
        </div>
      </div>
    </div>
  );
}

export function MemoryConfigSection({
  activeUseCase,
}: {
  activeUseCase: LandingUseCaseShowcase;
}) {
  const nodes = activeUseCase.memory.recordTree.children?.slice(0, 4) ?? [
    activeUseCase.memory.recordTree,
  ];
  const relation = activeUseCase.memory.relations[0];

  return (
    <section
      id="memory"
      class="bg-[var(--color-page-bg)] px-4 py-24 sm:px-8 lg:py-32"
    >
      <div class="mx-auto max-w-[76rem]">
        <div class="mx-auto mb-16 max-w-3xl text-center">
          <div class="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-tg-accent)]">
            [02] Adaptive memory
          </div>
          <h2 class="text-4xl font-semibold leading-[1.04] tracking-[-0.055em] text-[var(--color-page-text)] sm:text-5xl lg:text-6xl">
            A seismic shift in agent memory flexibility.
          </h2>
          <p class="mx-auto mt-6 max-w-2xl text-base leading-8 text-[var(--color-page-text-muted)] sm:text-lg">
            Keep one agent local, or give every approved agent the same typed
            graph. The product surface shows what is remembered, where it came
            from, and how the next run can reuse it.
          </p>
        </div>

        <div class="grid gap-px overflow-hidden rounded-[1.5rem] border border-[var(--color-page-border)] bg-[var(--color-page-border)] lg:grid-cols-3">
          <Tile eyebrow="Filesystem" title="Local context">
            Scratch files, intermediate reports, and one-off notes stay close to
            the worker that created them.
          </Tile>
          <Tile eyebrow="Owletto" title="Shared graph">
            Typed entities, relationships, watchers, and connector data are
            shared across agents and users.
          </Tile>
          <Tile eyebrow="Gateway" title="Safe access">
            Workers receive scoped memory context and placeholders, not raw
            credentials or OAuth tokens.
          </Tile>
        </div>

        <div class="mt-6 overflow-hidden rounded-[1.6rem] border border-[var(--color-page-border)] bg-white shadow-[0_24px_90px_rgba(16,24,40,0.07)]">
          <div class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-page-border)] px-5 py-4">
            <div>
              <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
                Memory workspace
              </div>
              <h3 class="mt-1 text-xl font-semibold text-[var(--color-page-text)]">
                {activeUseCase.memory.title}
              </h3>
            </div>
            <span class="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              Synced through MCP
            </span>
          </div>

          <div class="grid gap-6 p-5 lg:grid-cols-[0.9fr_1.1fr] lg:p-6">
            <div class="grid gap-3">
              <Step
                index="1"
                title="Source update arrives"
                body="A webhook, connector sync, or watcher produces fresh context for the agent."
              />
              <Step
                index="2"
                title="Agent extracts facts"
                body="The run identifies records, fields, and relationships instead of writing a flat note."
              />
              <Step
                index="3"
                title="Graph becomes reusable"
                body="Future runs recall the same typed state from Slack, REST, MCP, or another worker."
              />
            </div>

            <div class="rounded-[1.35rem] border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4">
              <div class="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
                    Shared graph preview
                  </div>
                  <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
                    {activeUseCase.label} entities
                  </div>
                </div>
                <span class="text-xs text-[var(--color-page-text-muted)]">
                  Live
                </span>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    class="rounded-2xl border border-[var(--color-page-border)] bg-white p-4"
                  >
                    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-700">
                      {node.kind}
                    </div>
                    <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
                      {node.label}
                    </div>
                    <p class="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-page-text-muted)]">
                      {node.summary}
                    </p>
                  </div>
                ))}
              </div>

              {relation ? (
                <div class="mt-4 rounded-2xl border border-[var(--color-page-border)] bg-white p-4">
                  <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
                    Relationship
                  </div>
                  <div class="flex flex-wrap gap-2 text-xs">
                    <span class="rounded-full bg-orange-50 px-3 py-1 text-orange-700">
                      {relation.source}
                    </span>
                    <span class="rounded-full bg-blue-50 px-3 py-1 font-mono text-blue-700">
                      {relation.label}
                    </span>
                    <span class="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
                      {relation.target}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
