import type { ComponentChildren } from "preact";

type Props = {
  eyebrow?: string;
  title: string;
  description: string;
  ctaLabel?: string;
  ctaHref?: string;
  graphic: ComponentChildren;
  reverse?: boolean;
  showDottedBg?: boolean;
};

const ArrowRight = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
    class="ml-1"
  >
    <path
      d="M3 7h8m0 0L7 3M11 7l-4 4"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

export function FeatureBlock({
  eyebrow,
  title,
  description,
  ctaLabel,
  ctaHref,
  graphic,
  reverse,
  showDottedBg = true,
}: Props) {
  return (
    <div
      class="rounded-2xl overflow-hidden"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class={`grid grid-cols-1 md:grid-cols-2 ${showDottedBg ? "dotted-bg" : ""}`}
        style={{ background: "var(--color-page-bg)" }}
      >
        <div
          class={`p-8 sm:p-10 flex flex-col justify-center ${reverse ? "md:order-2" : ""}`}
        >
          {eyebrow ? (
            <div
              class="text-[12px] font-semibold tracking-[0.12em] uppercase mb-3"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {eyebrow}
            </div>
          ) : null}
          <h2
            class="font-display text-[28px] sm:text-[32px] font-semibold leading-[1.1] mb-4"
            style={{
              color: "var(--color-page-text)",
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </h2>
          <p
            class="text-[15px] leading-relaxed max-w-md mb-6"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {description}
          </p>
          {ctaLabel && ctaHref ? (
            <a
              href={ctaHref}
              class="inline-flex items-center text-[14px] font-medium transition-colors hover:opacity-80"
              style={{ color: "var(--color-page-text)" }}
            >
              {ctaLabel}
              <ArrowRight />
            </a>
          ) : null}
        </div>
        <div
          class={`p-6 sm:p-8 flex items-center justify-center min-h-[300px] ${reverse ? "md:order-1" : ""}`}
        >
          {graphic}
        </div>
      </div>
    </div>
  );
}
