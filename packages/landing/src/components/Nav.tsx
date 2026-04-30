import { useEffect, useRef, useState } from "preact/hooks";
import { landingUseCaseGroupedOptions } from "../use-case-showcases";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";
const GITHUB_STARS_BADGE =
  "https://img.shields.io/github/stars/lobu-ai/lobu?style=social";

type MenuLink = {
  label: string;
  description?: string;
  href: string;
  emoji?: string;
};

type MenuColumn = {
  heading: string;
  links: MenuLink[];
  variant?: "rich" | "plain";
};

type MegaMenu = {
  id: string;
  label: string;
  columns: MenuColumn[];
  width: string;
};

function buildSolutionsMenu(): MegaMenu {
  const groups = landingUseCaseGroupedOptions;

  const richColumns: MenuColumn[] = groups.slice(0, 2).map((group) => ({
    heading: group.label.toUpperCase(),
    variant: "rich",
    links: group.useCases.map((uc) => ({
      label: uc.label,
      description: group.description,
      href: `/for/${uc.id}`,
      emoji: uc.emoji,
    })),
  }));

  const startedLinks: MenuLink[] = [
    { label: "Memory", href: "/#memory" },
    { label: "Skills", href: "/#skills" },
    { label: "Watchers", href: "/#autonomous" },
    { label: "Platforms", href: "/#platforms" },
    { label: "Self-host", href: "/#hosting" },
    { label: "Architecture", href: "/guides/architecture/" },
    { label: "Benchmarks", href: "/guides/memory-benchmarks/" },
  ];

  return {
    id: "solutions",
    label: "Solutions",
    width: "min(56rem, calc(100vw - 2rem))",
    columns: [
      ...richColumns,
      {
        heading: "GET STARTED",
        variant: "plain",
        links: startedLinks,
      },
    ],
  };
}

const RESOURCES_MENU: MegaMenu = {
  id: "resources",
  label: "Resources",
  width: "min(36rem, calc(100vw - 2rem))",
  columns: [
    {
      heading: "LEARN",
      variant: "rich",
      links: [
        {
          label: "Docs",
          description: "Build, deploy, and run agents",
          href: "/getting-started",
          emoji: "📘",
        },
        {
          label: "Blog",
          description: "Engineering notes and updates",
          href: "/blog",
          emoji: "✍️",
        },
      ],
    },
    {
      heading: "PROJECT",
      variant: "plain",
      links: [
        { label: "GitHub", href: GITHUB_URL },
        { label: "Changelog", href: "/blog" },
        { label: "Privacy", href: "/privacy" },
        { label: "Terms", href: "/terms" },
      ],
    },
  ],
};

function ChevronDown() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      class="ml-1"
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function MegaMenuPanel({ menu }: { menu: MegaMenu }) {
  return (
    <div
      class="absolute top-full left-0 pt-2 z-50"
      style={{ width: menu.width }}
    >
      <div
        class="rounded-2xl bg-white p-6 grid gap-x-8 gap-y-2"
        style={{
          gridTemplateColumns: `repeat(${menu.columns.length}, minmax(0, 1fr))`,
          border: "1px solid var(--color-page-border)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
        }}
      >
        {menu.columns.map((col) => (
          <div key={col.heading} class="min-w-0">
            <div
              class="text-[11px] font-semibold tracking-[0.12em] uppercase mb-3"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {col.heading}
            </div>
            <ul class="flex flex-col gap-1">
              {col.links.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    class="flex items-start gap-3 rounded-lg p-2 -mx-2 transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
                  >
                    <span class="flex flex-col min-w-0">
                      <span
                        class="text-[14px] font-semibold leading-snug"
                        style={{ color: "var(--color-page-text)" }}
                      >
                        {link.label}
                      </span>
                      {col.variant === "rich" && link.description ? (
                        <span
                          class="text-[12px] leading-snug mt-0.5 truncate"
                          style={{ color: "var(--color-page-text-muted)" }}
                        >
                          {link.description}
                        </span>
                      ) : null}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function MegaMenuTrigger({
  menu,
  openId,
  setOpenId,
}: {
  menu: MegaMenu;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const open = openId === menu.id;
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover disclosure wrapper; the inner button is keyboard-focusable and drives the same open state via onFocus.
    <div
      ref={containerRef}
      class="relative"
      onMouseEnter={() => setOpenId(menu.id)}
      onMouseLeave={() => setOpenId(null)}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onFocus={() => setOpenId(menu.id)}
        class="inline-flex items-center text-[14px] font-medium px-3 h-9 rounded-full transition-colors"
        style={{
          color: "var(--color-page-text)",
          background: open ? "var(--color-page-surface-dim)" : "transparent",
          border: open
            ? "1px solid var(--color-page-border)"
            : "1px solid transparent",
        }}
      >
        {menu.label}
        <ChevronDown />
      </button>
      {open ? <MegaMenuPanel menu={menu} /> : null}
    </div>
  );
}

type NavProps = {
  currentPath?: string;
};

export function Nav({ currentPath: _currentPath = "/" }: NavProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const solutions = buildSolutionsMenu();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="block text-center text-[13px] font-medium py-2 px-4 hover:opacity-80 transition-opacity"
        style={{ background: "#0b0b0d", color: "#ffffff" }}
      >
        Owletto memory · MCP · open source
        <span class="ml-2" aria-hidden="true">
          →
        </span>
      </a> */}

      <nav
        class="sticky top-0 z-40 px-4 sm:px-8"
        style={{
          backgroundColor: "var(--color-page-bg-overlay)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <div class="max-w-[72rem] mx-auto flex items-center gap-3 h-16">
          <a
            href="/"
            class="flex items-center gap-2 text-[17px] font-bold tracking-tight shrink-0 mr-4"
            style={{
              color: "var(--color-page-text)",
              fontFamily: "var(--font-display)",
            }}
          >
            <img src="/lobster-icon.png" alt="Lobu" class="w-7 h-7" />
            Lobu
          </a>
          <div class="hidden md:flex items-center gap-1">
            <MegaMenuTrigger
              menu={solutions}
              openId={openId}
              setOpenId={setOpenId}
            />
            <MegaMenuTrigger
              menu={RESOURCES_MENU}
              openId={openId}
              setOpenId={setOpenId}
            />
          </div>
          <div class="ml-auto flex items-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="hidden sm:inline-flex items-center gap-2 text-[13px] font-medium px-3 h-9 rounded-full transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
              style={{ color: "var(--color-page-text)" }}
            >
              <img
                src={GITHUB_STARS_BADGE}
                alt="GitHub stars"
                style={{ height: "18px" }}
              />
            </a>
            <a
              href="/getting-started"
              class="hidden sm:inline-flex items-center text-[14px] font-medium px-3 h-9 rounded-full transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
              style={{ color: "var(--color-page-text)" }}
            >
              Sign in
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center text-[14px] font-medium px-4 h-9 rounded-full transition-opacity hover:opacity-90"
              style={{ background: "#0b0b0d", color: "#ffffff" }}
            >
              Start for free
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
