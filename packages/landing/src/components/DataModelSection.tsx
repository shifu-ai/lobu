type Attribute = { name: string; icon: string };

type EntityCard = {
  id: string;
  label: string;
  emoji: string;
  badge: string;
  attributes: Attribute[];
  moreCount: number;
};

const ENTITIES: EntityCard[] = [
  {
    id: "member",
    label: "Member",
    emoji: "👤",
    badge: "Standard",
    attributes: [
      { name: "Identity", icon: "🪪" },
      { name: "Preferences", icon: "⚙" },
      { name: "Decisions", icon: "✅" },
    ],
    moreCount: 5,
  },
  {
    id: "asset",
    label: "Asset",
    emoji: "💼",
    badge: "Standard",
    attributes: [
      { name: "Valuation", icon: "📊" },
      { name: "Transaction", icon: "💸" },
      { name: "Source", icon: "🔗" },
    ],
    moreCount: 3,
  },
  {
    id: "topic",
    label: "Topic",
    emoji: "🗂",
    badge: "Standard",
    attributes: [
      { name: "Summary", icon: "📝" },
      { name: "Watchers", icon: "🔔" },
      { name: "Linked records", icon: "🔁" },
    ],
    moreCount: 2,
  },
];

const RELATIONSHIPS: { afterIndex: number; label: string }[] = [
  { afterIndex: 0, label: "owns" },
  { afterIndex: 1, label: "linked to" },
];

function EntityCardView({ entity }: { entity: EntityCard }) {
  return (
    <div
      class="rounded-xl bg-white shadow-sm w-full"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class="flex items-center gap-2 px-3 py-2.5"
        style={{ borderBottom: "1px solid var(--color-page-border)" }}
      >
        <span
          class="inline-flex items-center justify-center w-6 h-6 rounded-md text-[14px]"
          style={{
            background: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
          }}
          aria-hidden="true"
        >
          {entity.emoji}
        </span>
        <span
          class="text-[14px] font-semibold flex-1"
          style={{ color: "var(--color-page-text)" }}
        >
          {entity.label}
        </span>
        <span
          class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{
            background: "var(--color-page-surface-dim)",
            color: "var(--color-page-text-muted)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          {entity.badge}
        </span>
      </div>
      <ul class="flex flex-col">
        {entity.attributes.map((attr) => (
          <li
            key={attr.name}
            class="flex items-center gap-2 px-3 py-2 text-[13px]"
            style={{ color: "var(--color-page-text)" }}
          >
            <span class="text-[11px] opacity-70" aria-hidden="true">
              {attr.icon}
            </span>
            <span>{attr.name}</span>
          </li>
        ))}
        <li
          class="flex items-center gap-2 px-3 py-2 text-[12px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <span aria-hidden="true">+</span>
          <span>{entity.moreCount} more attributes</span>
        </li>
      </ul>
    </div>
  );
}

function AddObjectCard() {
  return (
    <div
      class="rounded-xl flex items-center justify-center min-h-[180px] w-full"
      style={{
        border: "1px dashed rgba(59, 130, 246, 0.55)",
        background: "rgba(59, 130, 246, 0.04)",
        color: "rgb(37, 99, 235)",
      }}
    >
      <span class="inline-flex items-center gap-2 text-[13px] font-medium">
        <span
          aria-hidden="true"
          class="inline-flex items-center justify-center w-5 h-5 rounded-md"
          style={{ background: "rgba(59, 130, 246, 0.12)" }}
        >
          +
        </span>
        Add object
      </span>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div
      class="relative flex items-center justify-center self-center shrink-0"
      style={{ width: "84px", height: "32px" }}
      aria-hidden="true"
    >
      <div
        class="absolute left-0 right-0 top-1/2 h-px"
        style={{ background: "rgba(0,0,0,0.18)" }}
      />
      <span
        class="relative inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium"
        style={{
          background: "var(--color-page-bg)",
          border: "1px solid var(--color-page-border)",
          color: "var(--color-page-text-muted)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function MobileConnector({ label }: { label: string }) {
  return (
    <div
      class="relative flex flex-col items-center justify-center self-center"
      style={{ height: "40px" }}
      aria-hidden="true"
    >
      <div
        class="absolute top-0 bottom-0 w-px"
        style={{ background: "rgba(0,0,0,0.18)" }}
      />
      <span
        class="relative inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium"
        style={{
          background: "var(--color-page-bg)",
          border: "1px solid var(--color-page-border)",
          color: "var(--color-page-text-muted)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function DataModelSection() {
  return (
    <section class="relative px-4 sm:px-6 max-w-[72rem] mx-auto">
      <div
        class="relative rounded-2xl overflow-hidden dotted-bg"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div class="px-6 sm:px-10 pt-10 pb-6 max-w-3xl">
          <div
            class="text-[12px] font-semibold tracking-[0.12em] uppercase mb-3"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Adapt the model to your shape
          </div>
          <h2
            class="font-display text-[28px] sm:text-[32px] font-semibold leading-[1.1] mb-3"
            style={{
              color: "var(--color-page-text)",
              letterSpacing: "-0.02em",
            }}
          >
            One memory schema, every record type.
          </h2>
          <p
            class="text-[15px] leading-relaxed max-w-xl"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Members, assets, topics. Extend the schema with your own objects and
            define how they relate. Lobu Memory routes events, embeddings, and
            watchers along those edges automatically.
          </p>
        </div>

        <div class="px-6 sm:px-10 pt-6 pb-10">
          <div class="hidden md:flex items-stretch gap-3">
            {ENTITIES.map((entity, i) => (
              <>
                <div key={entity.id} class="flex-1 min-w-0">
                  <EntityCardView entity={entity} />
                </div>
                {RELATIONSHIPS.find((r) => r.afterIndex === i) ? (
                  <Connector
                    key={`rel-${i}`}
                    label={RELATIONSHIPS.find((r) => r.afterIndex === i)!.label}
                  />
                ) : null}
              </>
            ))}
            <div class="w-3 shrink-0" aria-hidden="true" />
            <div class="flex-1 min-w-0">
              <AddObjectCard />
            </div>
          </div>

          <div class="md:hidden flex flex-col gap-3">
            {ENTITIES.map((entity, i) => {
              const rel = RELATIONSHIPS.find((r) => r.afterIndex === i);
              return (
                <>
                  <EntityCardView key={entity.id} entity={entity} />
                  {rel ? (
                    <MobileConnector key={`rel-${i}`} label={rel.label} />
                  ) : null}
                </>
              );
            })}
            <AddObjectCard />
          </div>
        </div>
      </div>
    </section>
  );
}
