import type { ComponentChildren } from "preact";
import type { RecordNode } from "../use-case-definitions";
import type { LandingUseCaseShowcase, TraceRow } from "../use-case-showcases";
import { deliverySurfaces } from "./platforms";

function getNodes(showcase: LandingUseCaseShowcase): RecordNode[] {
  const children = showcase.memory.recordTree.children ?? [];
  return children.length ? children.slice(0, 4) : [showcase.memory.recordTree];
}

function getTrace(showcase: LandingUseCaseShowcase): TraceRow[] {
  return (showcase.runtime.trace ?? []).slice(0, 5);
}

function ProductFrame({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ComponentChildren;
}) {
  return (
    <div class="overflow-hidden rounded-[1.6rem] border border-[var(--color-page-border)] bg-white shadow-[0_24px_90px_rgba(16,24,40,0.08)]">
      <div class="flex items-center justify-between gap-3 border-b border-[var(--color-page-border)] px-5 py-4">
        <div>
          <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
            {eyebrow}
          </div>
          <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
            {title}
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span class="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <span class="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
      </div>
      <div class="p-5 sm:p-6">{children}</div>
    </div>
  );
}

function FigureCard({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div class="border-[var(--color-page-border)] px-6 py-8 md:border-r last:border-r-0">
      <div class="mb-10 text-[11px] font-mono uppercase tracking-[0.24em] text-[var(--color-page-text-muted)]">
        Fig {index}
      </div>
      <div class="relative mb-9 h-28 opacity-80">
        <div class="absolute left-1/2 top-4 h-20 w-20 -translate-x-1/2 rotate-45 rounded-2xl border border-[var(--color-page-border-active)] bg-white" />
        <div class="absolute left-1/2 top-9 h-20 w-20 -translate-x-1/2 rotate-45 rounded-2xl border border-[var(--color-page-border)]" />
        <div class="absolute left-1/2 top-14 h-20 w-20 -translate-x-1/2 rotate-45 rounded-2xl border border-[var(--color-page-border)]" />
        <div class="absolute left-1/2 top-12 h-10 w-10 -translate-x-1/2 rounded-full border border-orange-300 bg-orange-50" />
      </div>
      <h3 class="text-lg font-semibold text-[var(--color-page-text)]">
        {title}
      </h3>
      <p class="mt-3 text-sm leading-6 text-[var(--color-page-text-muted)]">
        {body}
      </p>
    </div>
  );
}

function IntakeVisual({ showcase }: { showcase: LandingUseCaseShowcase }) {
  const events = showcase.runtime.events.slice(0, 3);

  return (
    <ProductFrame
      title={`${showcase.label} intake`}
      eyebrow="Chat → structured work"
    >
      <div class="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <div class="rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4">
          <div class="mb-4 flex items-center justify-between text-xs text-[var(--color-page-text-muted)]">
            <span># {showcase.label.toLowerCase()}-ops</span>
            <span>live thread</span>
          </div>
          <div class="space-y-4">
            {events.map((event, index) => (
              <div key={`${event.source}-${index}`} class="flex gap-3">
                <div class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-xs font-semibold text-[var(--color-page-text)] shadow-sm">
                  {event.source.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div class="text-sm font-semibold text-[var(--color-page-text)]">
                    {event.source}{" "}
                    <span class="font-normal text-[var(--color-page-text-muted)]">
                      {event.time}
                    </span>
                  </div>
                  <p class="mt-1 text-sm leading-6 text-[var(--color-page-text-muted)]">
                    {event.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div class="mt-5 rounded-2xl border border-[var(--color-page-border)] bg-white p-4 text-sm leading-6 text-[var(--color-page-text)]">
            @Lobu {showcase.runtime.request}
          </div>
        </div>
        <div class="grid content-start gap-3">
          {[
            "Collected source updates",
            "Classified urgency",
            "Created run with context",
          ].map((item, index) => (
            <div
              key={item}
              class="flex items-center justify-between rounded-2xl border border-[var(--color-page-border)] bg-white p-4"
            >
              <span class="text-sm font-medium text-[var(--color-page-text)]">
                {item}
              </span>
              <span class="font-mono text-xs text-[var(--color-tg-accent)]">
                0{index + 1}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ProductFrame>
  );
}

function OperatingModelVisual({
  showcase,
}: {
  showcase: LandingUseCaseShowcase;
}) {
  const nodes = getNodes(showcase);

  return (
    <ProductFrame title="Operating model" eyebrow="Entities, watchers, recall">
      <div class="grid gap-4 lg:grid-cols-[0.85fr_1fr]">
        <div class="rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4">
          <div class="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
            World model
          </div>
          <div class="space-y-3">
            {nodes.map((node) => (
              <div
                key={node.id}
                class="rounded-xl border border-[var(--color-page-border)] bg-white p-3"
              >
                <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-700">
                  {node.kind}
                </div>
                <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
                  {node.label}
                </div>
                <div class="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-page-text-muted)]">
                  {node.summary}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div class="grid gap-4">
          <div class="rounded-2xl border border-[var(--color-page-border)] bg-white p-4">
            <div class="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
              Watcher output
            </div>
            <div class="space-y-2 font-mono text-xs leading-6 text-[var(--color-page-text)]">
              <div>
                risk_level: <span class="text-orange-700">updated</span>
              </div>
              <div>activity_delta: new signal captured</div>
              <div>relationships: linked across records</div>
            </div>
          </div>
          <div class="rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4">
            <div class="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
              Timeline
            </div>
            <div class="relative space-y-4 before:absolute before:bottom-2 before:left-[0.45rem] before:top-2 before:w-px before:bg-[var(--color-page-border)]">
              {["Poll", "Extract", "Merge", "Recall"].map((item) => (
                <div
                  key={item}
                  class="relative flex items-center gap-3 text-sm text-[var(--color-page-text-muted)]"
                >
                  <span class="relative z-10 h-2.5 w-2.5 rounded-full bg-orange-500" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </ProductFrame>
  );
}

function RunVisual({ showcase }: { showcase: LandingUseCaseShowcase }) {
  const trace = getTrace(showcase);

  return (
    <ProductFrame title="Agent run" eyebrow="Tools, memory, trace">
      <div class="mb-4 rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4 text-sm leading-6 text-[var(--color-page-text)]">
        {showcase.runtime.request}
      </div>
      <div class="grid gap-2">
        {trace.map((row, index) => (
          <div
            key={`${row.call}-${index}`}
            class="flex items-start gap-3 rounded-2xl border border-[var(--color-page-border)] bg-white p-3"
          >
            <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
            <div class="min-w-0">
              <div class="truncate font-mono text-xs text-[var(--color-page-text)]">
                {row.call}
              </div>
              <div class="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-page-text-muted)]">
                {row.result}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div class="mt-4 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm leading-6 text-orange-950">
        {showcase.runtime.response}
      </div>
    </ProductFrame>
  );
}

function ShipVisual({ showcase }: { showcase: LandingUseCaseShowcase }) {
  return (
    <ProductFrame title="Delivery surfaces" eyebrow="One agent everywhere">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {deliverySurfaces.slice(0, 6).map((surface) => (
          <a
            key={surface.id}
            href={surface.href}
            class="rounded-2xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-4 transition-colors hover:bg-white"
          >
            <div class="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-white text-[var(--color-page-text)] shadow-sm">
              {surface.renderIcon(16)}
            </div>
            <div class="text-sm font-semibold text-[var(--color-page-text)]">
              {surface.label}
            </div>
            <p class="mt-2 text-xs leading-5 text-[var(--color-page-text-muted)]">
              {surface.detail}
            </p>
          </a>
        ))}
      </div>
      <div class="mt-4 rounded-2xl border border-[var(--color-page-border)] bg-white p-4 text-sm leading-6 text-[var(--color-page-text-muted)]">
        Same {showcase.label.toLowerCase()} context, approvals, and memory
        across every surface.
      </div>
    </ProductFrame>
  );
}

function AttioBlock({
  index,
  label,
  title,
  body,
  children,
  reverse,
}: {
  index: string;
  label: string;
  title: string;
  body: string;
  children: ComponentChildren;
  reverse?: boolean;
}) {
  return (
    <article class="grid gap-10 border-t border-[var(--color-page-border)] py-20 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16 lg:py-28">
      <div class={reverse ? "lg:order-2" : undefined}>
        <div class="mb-6 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-tg-accent)]">
          [{index}] {label}
        </div>
        <h3 class="max-w-xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] text-[var(--color-page-text)] sm:text-5xl">
          {title}
        </h3>
        <p class="mt-6 max-w-xl text-base leading-8 text-[var(--color-page-text-muted)] sm:text-lg">
          {body}
        </p>
      </div>
      <div class={reverse ? "lg:order-1" : undefined}>{children}</div>
    </article>
  );
}

export function AgentScrollStory({
  activeUseCase,
}: {
  activeUseCase: LandingUseCaseShowcase;
}) {
  return (
    <section
      id="how-it-works"
      class="bg-[var(--color-page-bg)] px-4 py-24 sm:px-8 lg:py-32"
    >
      <div class="mx-auto max-w-[76rem]">
        <div class="mb-16 flex flex-wrap items-center gap-x-10 gap-y-4 text-sm font-semibold text-[var(--color-page-text-muted)]">
          {["Slack", "GitHub", "OpenClaw", "Owletto", "Claude", "Telegram"].map(
            (item) => (
              <span key={item}>{item}</span>
            )
          )}
        </div>

        <div class="mb-20 max-w-6xl">
          <h2 class="text-5xl font-semibold leading-[1.02] tracking-[-0.06em] text-[var(--color-page-text)] sm:text-6xl lg:text-7xl">
            A new species of agent platform.{" "}
            <span class="text-[rgba(28,29,31,0.38)]">
              Purpose-built for teams that need memory, tools, goals, and
              chat-native delivery in one system.
            </span>
          </h2>
        </div>

        <div class="mb-20 grid border-y border-[var(--color-page-border)] md:grid-cols-3">
          <FigureCard
            index="0.1"
            title="Built for your world"
            body="Model the entities, relationships, and source data your agents should remember."
          />
          <FigureCard
            index="0.2"
            title="Powered by MCP"
            body="Connect tools through explicit skills, proxying, auth, and network policy."
          />
          <FigureCard
            index="0.3"
            title="Designed to keep moving"
            body="Scheduled watchers and approvals let agents act without losing control."
          />
        </div>

        <AttioBlock
          index="1.0"
          label="Intake"
          title="Turn conversations into actionable agent runs"
          body="Lobu starts where work already happens. Chat messages, webhooks, and scheduled source updates become structured work with context attached."
        >
          <IntakeVisual showcase={activeUseCase} />
        </AttioBlock>

        <AttioBlock
          index="2.0"
          label="Model"
          title="Define the operating model once"
          body="Your world model is explicit: entities, relationships, watchers, extraction schemas, and recall rules that every agent run can reuse."
          reverse
        >
          <OperatingModelVisual showcase={activeUseCase} />
        </AttioBlock>

        <AttioBlock
          index="3.0"
          label="Run"
          title="Move work forward across tools and agents"
          body="Workers call approved MCP tools through the gateway, update durable memory, and report the trace back to the team."
        >
          <RunVisual showcase={activeUseCase} />
        </AttioBlock>

        <AttioBlock
          index="4.0"
          label="Ship"
          title="Connect everywhere without rebuilding the agent"
          body="The same agent logic renders into Slack, Telegram, WhatsApp, Teams, Discord, REST, and MCP clients through platform adapters."
          reverse
        >
          <ShipVisual showcase={activeUseCase} />
        </AttioBlock>
      </div>
    </section>
  );
}
