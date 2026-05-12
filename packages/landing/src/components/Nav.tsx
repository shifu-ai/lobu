import type { ComponentChildren } from "preact";
import {
  getOwlettoLoginUrl,
  getOwlettoUrl,
  landingUseCaseGroupedOptions,
} from "../use-case-showcases";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";
const GITHUB_STARS_BADGE =
  "https://img.shields.io/github/stars/lobu-ai/lobu?style=social";

const resourceLinks = [
  {
    label: "Docs",
    href: "/getting-started/",
    description: "Install, configure, and self-host Lobu.",
  },
  {
    label: "Blog",
    href: "/blog/",
    description: "Design notes, benchmarks, and launch posts.",
  },
];

function getUseCaseFromPath(path: string): string | undefined {
  const match = path.match(/\/for\/([^/]+)/);
  return match?.[1];
}

function isActiveLink(currentPath: string, href: string): boolean {
  if (href === "/") return currentPath === "/";
  if (currentPath === href) return true;
  return currentPath.startsWith(`${href.replace(/\/$/, "")}/`);
}

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3 4.5 3 3 3-3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12A11.5 11.5 0 0 0 8.36 22.1c.58.1.79-.25.79-.56v-1.95c-3.18.69-3.85-1.35-3.85-1.35-.52-1.31-1.27-1.66-1.27-1.66-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.76 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.54-.29-5.2-1.27-5.2-5.64 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.06 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.77.11 3.06.74.8 1.18 1.83 1.18 3.08 0 4.38-2.67 5.35-5.22 5.63.41.36.77 1.08.77 2.18v3.24c0 .31.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function Dropdown(props: {
  label: string;
  active?: boolean;
  children: ComponentChildren;
}) {
  return (
    <details class="group/nav relative">
      <summary
        class="flex list-none items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-page-surface)] [&::-webkit-details-marker]:hidden"
        style={{
          color: props.active
            ? "var(--color-page-text)"
            : "var(--color-page-text-muted)",
        }}
      >
        {props.label}
        <span class="transition-transform group-open/nav:rotate-180">
          <Chevron />
        </span>
      </summary>
      <div class="absolute left-0 top-[calc(100%+0.55rem)] z-50 w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-[var(--color-page-border)] bg-white p-2 shadow-[0_24px_80px_rgba(16,24,40,0.14)]">
        {props.children}
      </div>
    </details>
  );
}

type NavProps = {
  currentPath?: string;
};

export function Nav({ currentPath = "/" }: NavProps) {
  const pathUseCaseId = getUseCaseFromPath(currentPath);
  const knownUseCaseIds = landingUseCaseGroupedOptions.flatMap((group) =>
    group.useCases.map((useCase) => useCase.id)
  );
  const activeUseCaseId = knownUseCaseIds.includes(pathUseCaseId ?? "")
    ? pathUseCaseId
    : undefined;
  const loginUrl = getOwlettoLoginUrl();
  const startUrl = getOwlettoUrl(activeUseCaseId);
  const solutionsActive = currentPath.startsWith("/for/");
  const resourcesActive =
    currentPath.startsWith("/getting-started") ||
    currentPath.startsWith("/guides") ||
    currentPath.startsWith("/reference") ||
    currentPath.startsWith("/platforms") ||
    currentPath.startsWith("/blog");

  return (
    <nav
      class="fixed left-0 right-0 top-0 z-50 border-b border-[var(--color-page-border)] bg-[var(--color-page-bg-overlay)] px-4 py-3 backdrop-blur-xl sm:px-6"
      aria-label="Main navigation"
    >
      <div class="flex w-full items-center gap-3">
        <a
          href="/"
          class="flex shrink-0 items-center gap-2 pr-2 text-xl font-bold tracking-[-0.04em] text-[var(--color-page-text)] sm:pr-6"
          aria-label="Lobu home"
        >
          <img src="/lobster-icon.png" alt="" class="h-7 w-7" />
          Lobu
        </a>

        <div class="hidden items-center gap-1 md:flex">
          <Dropdown label="Solutions" active={solutionsActive}>
            <div class="grid gap-2 p-1 sm:grid-cols-2">
              {landingUseCaseGroupedOptions.map((group) => (
                <div
                  key={group.id}
                  class="rounded-xl bg-[var(--color-page-bg)] p-2"
                >
                  <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
                    {group.label}
                  </div>
                  {group.useCases.map((useCase) => (
                    <a
                      key={useCase.id}
                      href={`/for/${useCase.id}/`}
                      class="flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-white"
                      style={{
                        color:
                          activeUseCaseId === useCase.id
                            ? "var(--color-page-text)"
                            : "var(--color-page-text-muted)",
                        fontWeight: activeUseCaseId === useCase.id ? 650 : 500,
                      }}
                    >
                      <span aria-hidden="true">{useCase.emoji}</span>
                      {useCase.label}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </Dropdown>

          <Dropdown label="Resources" active={resourcesActive}>
            <div class="grid gap-1 p-1">
              {resourceLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  class="rounded-xl px-3 py-3 transition-colors hover:bg-[var(--color-page-bg)]"
                  style={{ color: "var(--color-page-text)" }}
                >
                  <div class="text-sm font-semibold">{link.label}</div>
                  <div class="mt-1 text-xs leading-5 text-[var(--color-page-text-muted)]">
                    {link.description}
                  </div>
                </a>
              ))}
            </div>
          </Dropdown>

          <a
            href="/#connect-your-data"
            class="rounded-full px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-page-surface)]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Platform
          </a>
        </div>

        <div class="ml-auto hidden items-center gap-2 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-[var(--color-page-text-muted)] transition-colors hover:bg-[var(--color-page-surface)] hover:text-[var(--color-page-text)]"
          >
            <GitHubIcon />
            <span>GitHub</span>
            <img
              src={GITHUB_STARS_BADGE}
              alt="GitHub stars"
              height="20"
              class="hidden lg:block"
            />
          </a>
          <a
            href={loginUrl}
            class="rounded-xl border border-[var(--color-page-border-active)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-page-text)] transition-colors hover:bg-[var(--color-page-surface)]"
          >
            Sign in
          </a>
          <a
            href={startUrl}
            class="rounded-xl bg-[var(--color-page-text)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Start for free
          </a>
        </div>

        <div class="ml-auto flex items-center gap-2 md:hidden">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="grid h-9 w-9 place-items-center rounded-xl border border-[var(--color-page-border)] bg-white text-[var(--color-page-text)]"
            aria-label="GitHub"
          >
            <GitHubIcon />
          </a>
          <details class="group/mobile relative">
            <summary class="list-none rounded-xl bg-[var(--color-page-text)] px-4 py-2 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
              Menu
            </summary>
            <div class="absolute right-0 top-[calc(100%+0.6rem)] z-50 max-h-[78vh] w-[min(22rem,calc(100vw-2rem))] overflow-auto rounded-2xl border border-[var(--color-page-border)] bg-white p-3 shadow-[0_24px_80px_rgba(16,24,40,0.16)]">
              <div class="mb-3 grid gap-2">
                <a
                  href={loginUrl}
                  class="rounded-xl border border-[var(--color-page-border)] px-3 py-2 text-sm font-medium text-[var(--color-page-text)]"
                >
                  Sign in
                </a>
                <a
                  href={startUrl}
                  class="rounded-xl bg-[var(--color-page-text)] px-3 py-2 text-sm font-semibold text-white"
                >
                  Start for free
                </a>
              </div>
              <div class="border-t border-[var(--color-page-border)] pt-3">
                <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
                  Solutions
                </div>
                {landingUseCaseGroupedOptions
                  .flatMap((group) => group.useCases)
                  .map((useCase) => (
                    <a
                      key={useCase.id}
                      href={`/for/${useCase.id}/`}
                      class="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-page-text-muted)]"
                    >
                      <span aria-hidden="true">{useCase.emoji}</span>
                      {useCase.label}
                    </a>
                  ))}
              </div>
              <div class="mt-3 border-t border-[var(--color-page-border)] pt-3">
                <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
                  Resources
                </div>
                {resourceLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    class="block rounded-lg px-2 py-2 text-sm text-[var(--color-page-text-muted)]"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          </details>
        </div>
      </div>
    </nav>
  );
}
