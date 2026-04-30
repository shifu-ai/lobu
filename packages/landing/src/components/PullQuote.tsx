type Props = {
  quoteLead: string;
  quoteFade: string;
  attributionName: string;
  attributionRole: string;
};

export function PullQuote({
  quoteLead,
  quoteFade,
  attributionName,
  attributionRole,
}: Props) {
  return (
    <section class="relative px-4 sm:px-6">
      <div
        class="dotted-bg max-w-[72rem] mx-auto rounded-2xl py-20 sm:py-28 text-center"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <blockquote
          class="font-display max-w-4xl mx-auto px-6 leading-[1.1]"
          style={{
            fontSize: "clamp(2rem, 4.5vw, 3.5rem)",
            letterSpacing: "-0.02em",
            color: "var(--color-page-text)",
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">“</span>
          {quoteLead}{" "}
          <span style={{ color: "rgba(11,11,13,0.32)" }}>{quoteFade}</span>
          <span aria-hidden="true">”</span>
        </blockquote>
        <div
          class="mt-10 text-[14px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <div
            class="font-semibold"
            style={{ color: "var(--color-page-text)" }}
          >
            {attributionName}
          </div>
          <div class="opacity-80">{attributionRole}</div>
        </div>
      </div>
    </section>
  );
}
