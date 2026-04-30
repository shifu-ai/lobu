import type { ComponentChildren } from "preact";

type Props = {
  index: number;
  leftLabel: string;
  rightLabel: string;
  children: ComponentChildren;
  id?: string;
};

export function SectionCornerLabels({
  index,
  leftLabel,
  rightLabel,
  children,
  id,
}: Props) {
  const indexLabel = `[${index.toString().padStart(2, "0")}]`;

  return (
    <section id={id} class="relative px-4 sm:px-6 max-w-[72rem] mx-auto">
      <div
        class="flex items-center justify-between text-[11px] font-semibold tracking-[0.14em] uppercase pt-6 pb-3"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        <span>
          <span class="opacity-60">{indexLabel}</span> <span>{leftLabel}</span>
        </span>
        <span class="opacity-70">/ {rightLabel}</span>
      </div>
      {children}
    </section>
  );
}
