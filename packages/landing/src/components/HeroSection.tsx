import type { LandingUseCaseId } from "../use-case-definitions";
import {
  getLandingPrompt,
  getLandingUseCaseShowcase,
  getOwlettoUrl,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { CopyPromptButton } from "./CopyPromptButton";
import { HighlightedText } from "./HighlightedText";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

const GitHubIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 .5C5.65.5.5 5.65.5 12A11.5 11.5 0 0 0 8.36 22.1c.58.1.79-.25.79-.56v-1.95c-3.18.69-3.85-1.35-3.85-1.35-.52-1.31-1.27-1.66-1.27-1.66-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.76 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.54-.29-5.2-1.27-5.2-5.64 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.06 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.77.11 3.06.74.8 1.18 1.83 1.18 3.08 0 4.38-2.67 5.35-5.22 5.63.41.36.77 1.08.77 2.18v3.24c0 .31.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

export function HeroSection(props: {
  activeUseCaseId?: LandingUseCaseId;
  onActiveUseCaseChange?: (id: LandingUseCaseId) => void;
  linkTabsToCampaigns?: boolean;
  heroCopy?: SurfaceHeroCopy;
  useScopedOwlettoUrl?: boolean;
}) {
  const activeUseCase = getLandingUseCaseShowcase(props.activeUseCaseId);
  const owlettoUrl = getOwlettoUrl(
    props.useScopedOwlettoUrl ? activeUseCase.id : undefined
  );

  return (
    <section class="relative px-4 pb-8 pt-32 sm:px-8 sm:pb-12 sm:pt-36">
      <div class="mx-auto max-w-5xl text-center">
        <a
          href="/#connect-your-data"
          class="hero-rise hero-rise-1 inline-flex items-center gap-2 rounded-full border border-[var(--color-page-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--color-page-text-muted)] shadow-sm transition-colors hover:text-[var(--color-page-text)]"
        >
          Open source · Self-hosted · Now with app-first memory
          <span aria-hidden="true">→</span>
        </a>

        <h1 class="hero-rise hero-rise-2 mx-auto mt-7 max-w-[72rem] text-5xl font-bold leading-[0.98] tracking-[-0.075em] text-[var(--color-page-text)] sm:text-6xl lg:text-[4.9rem]">
          <HighlightedText
            text="The agent that never forgets."
            highlight="never forgets"
          />
          <br />
          <HighlightedText
            text="And never waits to be asked."
            highlight="never waits"
          />
        </h1>

        <p class="hero-rise hero-rise-3 mx-auto mt-6 max-w-2xl text-base leading-8 text-[var(--color-page-text-muted)] sm:text-xl sm:leading-9">
          {props.heroCopy?.description ?? (
            <>
              Ingest any data, connect any tool, define durable goals, and ship
              the same agent across Slack, Telegram, WhatsApp, REST, and MCP.
            </>
          )}
        </p>

        <div class="hero-rise hero-rise-4 relative z-20 mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href={owlettoUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-xl bg-[var(--color-page-text)] px-5 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Start for free
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-xl border border-[var(--color-page-border-active)] bg-white px-5 py-3 text-sm font-medium text-[var(--color-page-text)] transition-colors hover:bg-[var(--color-page-surface)]"
          >
            <GitHubIcon />
            View on GitHub
          </a>
          <CopyPromptButton
            prompt={getLandingPrompt(activeUseCase)}
            label="Copy prompt to your agent"
            triggerLabel="Integrate"
            supportedClients={["chatgpt", "openclaw", "claude", "mcp-client"]}
            supportedClientHrefForId={(clientId) => {
              if (clientId === "mcp-client") {
                return "/getting-started/memory/";
              }

              return `/connect-from/${clientId}/for/${activeUseCase.id}/`;
            }}
          />
        </div>
      </div>
    </section>
  );
}
