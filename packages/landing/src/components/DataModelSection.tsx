import type { LandingUseCaseId } from "../use-case-definitions";
import { landingUseCases } from "../use-case-definitions";

type Attribute = { name: string; icon: string };

type EntityCard = {
  id: string;
  label: string;
  emoji: string;
  badge: string;
  attributes: Attribute[];
  moreCount: number;
};

const ENTITY_EMOJI_FALLBACKS: Record<string, string> = {
  Member: "👤",
  Person: "👤",
  Company: "🏢",
  Founder: "🧑‍🚀",
  Investor: "🏦",
  "Fund Round": "💰",
  Sector: "🏭",
  Contract: "📜",
  Clause: "📑",
  Risk: "⚠️",
  Incident: "🚨",
  Service: "🧩",
  Deploy: "🚀",
  "Pull Request": "🔧",
  Customer: "👥",
  Ticket: "🎫",
  Issue: "🐞",
  Organization: "🏢",
  Deal: "💰",
  Task: "✅",
  Project: "📐",
  Decision: "✅",
  Topic: "🗂",
  Match: "🔗",
  Post: "📝",
};

const ATTRIBUTE_ICONS: Record<string, string> = {
  Type: "🏷",
  Name: "🪪",
  Company: "🏢",
  Founder: "🧑‍🚀",
  Founders: "🧑‍🚀",
  Funding: "💰",
  Stage: "📈",
  Valuation: "📊",
  Sector: "🏭",
  Role: "👤",
  Amount: "💸",
  Lead: "🏦",
  Risk: "⚠️",
  Status: "✅",
  Owner: "🧑‍💼",
  Source: "🔗",
};

const FALLBACK_ENTITIES: EntityCard[] = [
  {
    id: "user",
    label: "User",
    emoji: "👤",
    badge: "Entity",
    attributes: [
      { name: "Identity", icon: "🪪" },
      { name: "Sources", icon: "🔗" },
      { name: "Preferences", icon: "⚙️" },
    ],
    moreCount: 3,
  },
  {
    id: "source",
    label: "Source",
    emoji: "📄",
    badge: "Entity",
    attributes: [
      { name: "Content", icon: "📝" },
      { name: "Evidence", icon: "🔎" },
      { name: "Owner", icon: "🧑‍💼" },
    ],
    moreCount: 2,
  },
  {
    id: "topic",
    label: "Topic",
    emoji: "🗂",
    badge: "Entity",
    attributes: [
      { name: "Summary", icon: "📝" },
      { name: "Watchers", icon: "🔔" },
      { name: "Linked records", icon: "🔁" },
    ],
    moreCount: 2,
  },
];

function entityEmoji(label: string): string {
  if (ENTITY_EMOJI_FALLBACKS[label]) return ENTITY_EMOJI_FALLBACKS[label];
  if (label.endsWith("s") && ENTITY_EMOJI_FALLBACKS[label.slice(0, -1)]) {
    return ENTITY_EMOJI_FALLBACKS[label.slice(0, -1)];
  }
  return "📄";
}

function attributeIcon(label: string): string {
  return ATTRIBUTE_ICONS[label] ?? "•";
}

function buildUseCaseCards(useCaseId?: LandingUseCaseId): {
  entities: EntityCard[];
  relationships: { afterIndex: number; label: string }[];
  description: string;
} {
  const useCase = useCaseId ? landingUseCases[useCaseId] : null;
  if (!useCase) {
    return {
      entities: FALLBACK_ENTITIES,
      relationships: [
        { afterIndex: 0, label: "connects" },
        { afterIndex: 1, label: "links to" },
      ],
      description:
        "Users, sources, and topics become typed memory. Extend the schema with your own objects and relationships.",
    };
  }

  const children = useCase.memory.recordTree.children ?? [];
  const entities = useCase.model.entities.slice(0, 3).map((label) => {
    const selectedId = useCase.memory.entitySelections?.[label];
    const child = children.find((node) => node.kind === label);
    const highlights =
      (selectedId && useCase.memory.nodeHighlights?.[selectedId]) ||
      (child && useCase.memory.nodeHighlights?.[child.id]) ||
      [];
    const attributes = (
      highlights.length ? highlights : useCase.memory.highlights
    )
      .slice(0, 3)
      .map((field) => ({
        name: field.label,
        icon: attributeIcon(field.label),
      }));

    return {
      id: selectedId ?? child?.id ?? label.toLowerCase().replace(/\s+/g, "-"),
      label,
      emoji: entityEmoji(label),
      badge: "Entity",
      attributes,
      moreCount: Math.max(0, highlights.length - attributes.length),
    };
  });

  const relationships = entities.slice(0, -1).map((entity, index) => {
    const next = entities[index + 1];
    const matchingRelation = useCase.memory.relations.find((rel) => {
      const sourceType = rel.sourceType.toLowerCase().replace(/_/g, " ");
      const targetType = rel.targetType.toLowerCase().replace(/_/g, " ");
      const left = entity.label.toLowerCase();
      const right = next.label.toLowerCase();
      return (
        (sourceType === left && targetType === right) ||
        (sourceType === right && targetType === left)
      );
    });
    return {
      afterIndex: index,
      label: matchingRelation?.label.replace(/_/g, " ") ?? "linked to",
    };
  });

  return {
    entities: entities.length ? entities : FALLBACK_ENTITIES,
    relationships,
    description: `${useCase.label} agents use ${useCase.model.entities.slice(0, 5).join(", ")} as typed memory. Add your own entities and relationships as the workflow grows.`,
  };
}

function EntityCardView({ entity }: { entity: EntityCard }) {
  return (
    <div
      class="rounded-xl bg-[var(--color-page-surface)] shadow-sm w-full"
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

export function DataModelSection({
  useCaseId,
}: {
  useCaseId?: LandingUseCaseId;
}) {
  const { entities, relationships, description } = buildUseCaseCards(useCaseId);

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
            {description}
          </p>
        </div>

        <div class="px-6 sm:px-10 pt-6 pb-10">
          <div class="hidden md:flex items-stretch gap-3">
            {entities.map((entity, i) => (
              <>
                <div key={entity.id} class="flex-1 min-w-0">
                  <EntityCardView entity={entity} />
                </div>
                {relationships.find((r) => r.afterIndex === i) ? (
                  <Connector
                    key={`rel-${i}`}
                    label={relationships.find((r) => r.afterIndex === i)!.label}
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
            {entities.map((entity, i) => {
              const rel = relationships.find((r) => r.afterIndex === i);
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
