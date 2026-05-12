import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { LandingUseCaseId, RecordNode } from "../use-case-definitions";
import {
  getLandingUseCaseShowcase,
  type LandingUseCaseShowcase,
  type TraceRow,
} from "../use-case-showcases";
import { deliverySurfaces } from "./platforms";

const TAB_IDS = [
  "model-the-world",
  "connect-your-data",
  "define-goals",
  "connect-everywhere",
] as const;

type PlatformTabId = (typeof TAB_IDS)[number];

type StoryTab = {
  id: PlatformTabId;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  render: (showcase: LandingUseCaseShowcase) => ComponentChildren;
};

function records(showcase: LandingUseCaseShowcase): RecordNode[] {
  const children = showcase.memory.recordTree.children ?? [];
  return children.length ? children.slice(0, 5) : [showcase.memory.recordTree];
}

function traceRows(showcase: LandingUseCaseShowcase): TraceRow[] {
  return (showcase.runtime.trace ?? []).slice(0, 5);
}

function Shell({
  section,
  title,
  children,
  right,
}: {
  section: string;
  title: string;
  children: ComponentChildren;
  right?: ComponentChildren;
}) {
  return (
    <div class="overflow-hidden rounded-[1.55rem] border border-[var(--color-page-border)] bg-white shadow-[0_28px_100px_rgba(16,24,40,0.10)]">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-page-border)] px-4 py-3 sm:px-5">
        <div class="flex min-w-0 items-center gap-3">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[var(--color-page-text)] text-sm font-bold text-white">
            L
          </span>
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-[var(--color-page-text)]">
              {title}
            </div>
            <div class="truncate text-xs text-[var(--color-page-text-muted)]">
              {section}
            </div>
          </div>
        </div>
        {right ?? (
          <div class="flex items-center gap-2 text-xs text-[var(--color-page-text-muted)]">
            <span class="h-2 w-2 rounded-full bg-emerald-500" />
            Live workspace
          </div>
        )}
      </div>
      <div class="grid min-h-[34rem] grid-cols-[10rem_1fr] bg-[linear-gradient(90deg,#fbfbfa_0,#fbfbfa_10rem,#fff_10rem,#fff_100%)] max-md:grid-cols-1 max-md:bg-white">
        <aside class="border-r border-[var(--color-page-border)] p-3 max-md:hidden">
          {["Home", "World model", "Sources", "Goals", "Channels"].map(
            (item, index) => (
              <div
                key={item}
                class={`mb-1 rounded-lg px-3 py-2 text-xs ${
                  index === 1
                    ? "bg-[var(--color-page-surface)] font-semibold text-[var(--color-page-text)]"
                    : "text-[var(--color-page-text-muted)]"
                }`}
              >
                {item}
              </div>
            )
          )}
        </aside>
        <div class="min-w-0 p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

function Card({
  children,
  className = "",
}: {
  children: ComponentChildren;
  className?: string;
}) {
  return (
    <div
      class={`rounded-2xl border border-[var(--color-page-border)] bg-white p-4 shadow-sm ${className}`.trim()}
    >
      {children}
    </div>
  );
}

function SmallLabel({ children }: { children: ComponentChildren }) {
  return (
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
      {children}
    </div>
  );
}

function ModelWorld(showcase: LandingUseCaseShowcase) {
  const nodes = records(showcase);
  const relation = showcase.memory.relations[0];

  return (
    <Shell
      section="Model the world"
      title={`${showcase.label} operating model`}
    >
      <div class="grid gap-4 lg:grid-cols-[1fr_0.82fr]">
        <div class="grid gap-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <SmallLabel>Entity workspace</SmallLabel>
              <h3 class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[var(--color-page-text)]">
                {showcase.label}
              </h3>
            </div>
            <span class="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              Shared memory on
            </span>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            {nodes.slice(0, 4).map((node, index) => (
              <Card
                key={node.id}
                className={
                  index === 0
                    ? "bg-orange-50/55 border-orange-200"
                    : "bg-[var(--color-page-bg)]"
                }
              >
                <div class="mb-2 inline-flex rounded-full border border-orange-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-700">
                  {node.kind}
                </div>
                <div class="text-sm font-semibold text-[var(--color-page-text)]">
                  {node.label}
                </div>
                <p class="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-page-text-muted)]">
                  {node.summary}
                </p>
              </Card>
            ))}
          </div>

          {relation ? (
            <Card>
              <SmallLabel>Relationship created</SmallLabel>
              <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span class="rounded-full bg-orange-50 px-3 py-1 font-medium text-orange-700">
                  {relation.source}
                </span>
                <span class="rounded-full bg-blue-50 px-3 py-1 font-mono text-xs text-blue-700">
                  {relation.label}
                </span>
                <span class="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                  {relation.target}
                </span>
              </div>
            </Card>
          ) : null}
        </div>

        <Card className="bg-[var(--color-page-bg)]">
          <SmallLabel>How to do it</SmallLabel>
          <div class="mt-4 space-y-3">
            {[
              "Choose the records the agent must remember",
              "Add relationships that explain why things matter",
              "Let watchers merge fresh facts into the graph",
              "Recall the graph from every run and chat surface",
            ].map((item, index) => (
              <div
                key={item}
                class="flex gap-3 rounded-xl bg-white p-3 text-sm text-[var(--color-page-text)] shadow-sm"
              >
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-orange-50 text-xs font-semibold text-orange-700">
                  {index + 1}
                </span>
                {item}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Shell>
  );
}

function ConnectData(showcase: LandingUseCaseShowcase) {
  const skills = showcase.skills.skills.slice(0, 5);
  const domains = showcase.skills.allowedDomains.slice(0, 5);

  return (
    <Shell section="Connect your data" title="Sources and permissions">
      <div class="grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
        <Card className="bg-[var(--color-page-bg)]">
          <SmallLabel>Connected sources</SmallLabel>
          <div class="mt-4 grid gap-2">
            {skills.map((skill) => (
              <div
                key={skill}
                class="flex items-center justify-between rounded-xl bg-white px-3 py-3 shadow-sm"
              >
                <div class="text-sm font-semibold text-[var(--color-page-text)]">
                  {skill}
                </div>
                <div class="text-xs text-emerald-700">approved</div>
              </div>
            ))}
          </div>
        </Card>

        <div class="grid gap-4">
          <Card>
            <SmallLabel>Safe access</SmallLabel>
            <div class="mt-4 grid gap-3 sm:grid-cols-3">
              {[
                ["Gateway", "Swaps placeholders for real credentials"],
                ["Worker", "Receives scoped tools and context"],
                ["MCP", "Runs through approved proxy calls"],
              ].map(([title, body]) => (
                <div
                  key={title}
                  class="rounded-xl bg-[var(--color-page-bg)] p-3"
                >
                  <div class="text-sm font-semibold text-[var(--color-page-text)]">
                    {title}
                  </div>
                  <p class="mt-1 text-xs leading-5 text-[var(--color-page-text-muted)]">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <SmallLabel>Network policy</SmallLabel>
            <div class="mt-4 flex flex-wrap gap-2">
              {domains.map((domain) => (
                <span
                  key={domain}
                  class="rounded-full border border-[var(--color-page-border)] bg-[var(--color-page-bg)] px-3 py-1.5 text-xs text-[var(--color-page-text-muted)]"
                >
                  {domain}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </Shell>
  );
}

function DefineGoals(showcase: LandingUseCaseShowcase) {
  const trace = traceRows(showcase);

  return (
    <Shell section="Define goals" title={showcase.memory.watcher.name}>
      <div class="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Card className="bg-[var(--color-page-bg)]">
          <SmallLabel>Scheduled objective</SmallLabel>
          <div class="mt-3 rounded-2xl bg-white p-4 text-sm leading-6 text-[var(--color-page-text)] shadow-sm">
            {showcase.runtime.request}
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl bg-white p-3 shadow-sm">
              <SmallLabel>Cadence</SmallLabel>
              <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
                {showcase.runtime.schedule}
              </div>
            </div>
            <div class="rounded-xl bg-white p-3 shadow-sm">
              <SmallLabel>Approval</SmallLabel>
              <div class="mt-1 text-sm font-semibold text-[var(--color-page-text)]">
                Required for destructive tools
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <SmallLabel>Run timeline</SmallLabel>
          <div class="mt-4 space-y-2">
            {trace.map((row, index) => (
              <div
                key={`${row.call}-${index}`}
                class="flex items-start gap-3 rounded-xl border border-[var(--color-page-border)] bg-[var(--color-page-bg)] p-3"
              >
                <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-orange-500" />
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
        </Card>
      </div>
    </Shell>
  );
}

function ConnectEverywhere(showcase: LandingUseCaseShowcase) {
  return (
    <Shell section="Connect everywhere" title="Delivery surfaces">
      <div class="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
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
        <Card>
          <SmallLabel>Same agent, every surface</SmallLabel>
          <p class="mt-3 text-sm leading-6 text-[var(--color-page-text-muted)]">
            The same {showcase.label.toLowerCase()} memory, approvals, and run
            trace render into chat, REST, and MCP clients through platform
            adapters.
          </p>
          <div class="mt-5 rounded-2xl bg-[var(--color-page-bg)] p-4 text-sm leading-6 text-[var(--color-page-text)]">
            {showcase.runtime.response}
          </div>
        </Card>
      </div>
    </Shell>
  );
}

const STORY_TABS: StoryTab[] = [
  {
    id: "model-the-world",
    label: "Model the world",
    eyebrow: "01 · Memory",
    title: "Build the operating model first.",
    description:
      "Start by modeling the people, systems, records, and relationships your agent must understand before it acts.",
    render: ModelWorld,
  },
  {
    id: "connect-your-data",
    label: "Connect your data",
    eyebrow: "02 · Sources",
    title: "Attach tools without exposing secrets.",
    description:
      "Connect MCP servers, SaaS APIs, and source systems through gateway-mediated access and scoped network policy.",
    render: ConnectData,
  },
  {
    id: "define-goals",
    label: "Define goals",
    eyebrow: "03 · Runs",
    title: "Turn intent into scheduled agent work.",
    description:
      "Define what the agent should keep checking, when it should act, and when it must ask for approval.",
    render: DefineGoals,
  },
  {
    id: "connect-everywhere",
    label: "Connect everywhere",
    eyebrow: "04 · Surfaces",
    title: "Ship the same agent everywhere.",
    description:
      "Use the same state, trace, and approvals across Slack, Telegram, WhatsApp, REST, and MCP clients.",
    render: ConnectEverywhere,
  },
];

export function PlatformStory(props: { activeUseCaseId?: LandingUseCaseId }) {
  const showcase = useMemo(
    () => getLandingUseCaseShowcase(props.activeUseCaseId),
    [props.activeUseCaseId]
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const activeTab = STORY_TABS[activeIndex] ?? STORY_TABS[0];

  useEffect(() => {
    const hash = window.location.hash.replace("#", "") as PlatformTabId;
    const index = STORY_TABS.findIndex((tab) => tab.id === hash);
    if (index >= 0) setActiveIndex(index);
  }, []);

  useEffect(() => {
    if (
      paused ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % STORY_TABS.length);
    }, 5200);

    return () => window.clearInterval(interval);
  }, [paused]);

  return (
    <section
      class="relative px-4 pb-24 sm:px-8"
      aria-label="How Lobu works"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div class="mx-auto max-w-[76rem]">
        <div class="grid grid-cols-2 border-y border-[var(--color-page-border)] bg-white/70 lg:grid-cols-4">
          {STORY_TABS.map((tab, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={tab.id}
                id={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveIndex(index)}
                class="group relative min-h-16 border-r border-[var(--color-page-border)] px-3 py-4 text-center text-sm transition-colors last:border-r-0 hover:bg-white sm:text-base"
                style={{
                  color: active
                    ? "var(--color-page-text)"
                    : "var(--color-page-text-muted)",
                  fontWeight: active ? 650 : 500,
                  backgroundColor: active ? "#fff" : "transparent",
                }}
              >
                {active ? (
                  <span class="absolute left-0 right-0 top-0 h-0.5 bg-[var(--color-tg-accent)]" />
                ) : null}
                {tab.label}
              </button>
            );
          })}
        </div>

        <div class="grid gap-8 border-b border-[var(--color-page-border)] bg-[var(--color-page-bg)] py-10 lg:grid-cols-[0.35fr_0.65fr] lg:gap-10">
          <div class="lg:pt-6">
            <div class="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
              {activeTab.eyebrow}
            </div>
            <h2 class="max-w-md text-3xl font-semibold leading-[1.05] tracking-[-0.055em] text-[var(--color-page-text)] sm:text-4xl">
              {activeTab.title}
            </h2>
            <p class="mt-4 max-w-md text-sm leading-7 text-[var(--color-page-text-muted)] sm:text-base">
              {activeTab.description}
            </p>
          </div>
          <div>{activeTab.render(showcase)}</div>
        </div>
      </div>
    </section>
  );
}
