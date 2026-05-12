import type { LandingUseCaseId } from "../use-case-definitions";
import { getOwlettoUrl } from "../use-case-showcases";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";

export function CTA(props: {
  activeUseCaseId?: LandingUseCaseId;
  useScopedOwlettoUrl?: boolean;
}) {
  const owlettoUrl = getOwlettoUrl(
    props.useScopedOwlettoUrl ? props.activeUseCaseId : undefined
  );

  return (
    <section id="get-started" class="px-4 py-20 text-center sm:px-8">
      <div class="mx-auto max-w-2xl">
        <div class="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-page-text-muted)]">
          Start building
        </div>
        <h2 class="mb-4 text-3xl font-semibold tracking-[-0.055em] text-[var(--color-page-text)] sm:text-4xl">
          Build the agent your business actually needs.
        </h2>
        <p class="mx-auto mb-8 max-w-xl text-sm leading-7 text-[var(--color-page-text-muted)] sm:text-base">
          Start from the live workspace, copy the implementation prompt into your coding agent, or book 20 minutes to walk through the architecture.
        </p>
        <div class="mb-8 flex flex-wrap justify-center gap-3">
          <a
            href={owlettoUrl}
            class="inline-flex items-center gap-2 rounded-xl bg-[var(--color-page-text)] px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Start for free
          </a>
          <ScheduleCallButton class="inline-flex items-center gap-2 rounded-xl border border-[var(--color-page-border-active)] bg-white px-6 py-3 text-sm font-medium text-[var(--color-page-text)] transition-colors hover:bg-[var(--color-page-surface)]">
            <ScheduleCallIcon />
            Talk to Founder
          </ScheduleCallButton>
        </div>

        <div class="flex flex-wrap items-center justify-center gap-4 text-xs text-[var(--color-page-text-muted)]">
          <a href="/#model-the-world" class="hover:text-[var(--color-page-text)]">
            Model the world
          </a>
          <span class="opacity-30">|</span>
          <a href="/#connect-your-data" class="hover:text-[var(--color-page-text)]">
            Connect your data
          </a>
          <span class="opacity-30">|</span>
          <a href="/getting-started/" class="hover:text-[var(--color-page-text)]">
            Self-host docs
          </a>
          <span class="opacity-30">|</span>
          <a href="/platforms/rest-api/" class="hover:text-[var(--color-page-text)]">
            Embed
          </a>
        </div>
      </div>
    </section>
  );
}
