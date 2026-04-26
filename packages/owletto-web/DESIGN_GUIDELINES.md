# Design Guidelines — owletto-web

Read this before adding a new page, panel, empty state, form, or destructive action. The rules exist because the codebase is already 80% consistent — the goal is to make the convention explicit and stop the remaining drift.

When a rule and an existing file disagree, fix the file as part of your change. When the rule itself is wrong for your case, update this doc in the same PR — don't leave a silent exception.

---

## 1. Confirmations are embedded, never modal

**Hard rule:** never call `window.confirm`, `window.alert`, or `window.prompt`. Confirmations live inline — in the row, sheet footer, or page where the action lives — not in a popup `<AlertDialog>`.

**Pattern:** boolean `confirming` state + button-pair swap. The trigger ("X" icon, "Delete agent", etc.) hides and is replaced in place by `[Confirm] [Cancel]`. Match one of these existing examples to the shape that fits your context:

- `src/components/entity-page.tsx` — toolbar button-pair swap
- `src/components/entity-tabs/watchers-tab/watchers-list.tsx` — per-row action-cell swap
- `src/components/agents/agent-sheets.tsx` — sheet footer button-pair
- `src/components/settings/entity-types/entity-type-sheet.tsx` — collapsible danger-zone section
- `src/components/settings/entity-types/relationship-types-tab.tsx` — most compact: row-level mini-confirm

**Cascade warnings** (e.g. "deleting will remove 4 connections, 12 events, 3 watchers") render inside the inline confirm block, as the *content* of the confirm. They are not a reason to escalate to a modal `<AlertDialog>`.

**No silent destructive actions.** Every remove / delete / disconnect / revoke button needs a two-step confirm — including "remove from this list" inside an editor. If the action is genuinely undoable mid-edit (removing an unsaved row from a draft form), the trigger button alone is fine; otherwise wire the inline confirm pattern in.

**`<Dialog>` is allowed** for OAuth flows, the command palette, and short single-purpose modals. Never for destructive confirmations.

---

## 2. Surfaces

- **Page background** is `bg-background`. Most content sits flat on it.
- **`<Card>` (`src/components/ui/card.tsx`) is the only elevated container.** When you reach for `border-border/80 shadow-sm` on a Card, that's drift — fix the base instead so every Card carries the same border.
- **Don't add `shadow-sm` to Cards.** It does nothing visible in dark theme and is weak in light.
- **No two adjacent Cards without a hierarchy difference.** When two surfaces stack, the secondary one drops to a transparent section (heading + spacing only). Twin cards with identical treatment compete for weight.
- **Dark `--card`** must be distinguishable from `--background` without leaning on the border. Today's tokens (`index.css`) target `oklch(0.18 0 0)` against `oklch(0.1 0 0)` background. If you change one, sanity-check the other.

---

## 3. Empty states

Use `<TabEmptyState>` from `src/components/entity-tabs/tab-states.tsx` for any region-sized empty state: icon + title + description + optional action.

**Banned:** `border border-dashed` on empty-state containers. Dashed borders signal a drop zone; this app has zero drop zones, so dashed-border should not appear on `<div>` empty states at all. If you find one, replace it with `<TabEmptyState>`.

**Plain `<p className="text-muted-foreground">No X</p>`** is acceptable only inside tight nested contexts (a table cell, an accordion section, a sidebar list). Never as a page-region empty state.

**Empty states should propose the next step.** If the user can act from here ("Connect MCP client", "Create your first watcher"), include a primary action button. "No items" with no path forward is a dead end.

---

## 4. Selection & active states

- Selected row / card: `bg-muted/50` + `ring-1 ring-ring`.
- **Banned:** `border-foreground` for selection. Pure white/black is reserved for text. A selected row outlined in pure white on a dark page is the brightest thing on the screen and fights primary CTAs for attention.
- Tab indicators (a single hairline at the bottom, not a full surrounding border) may use `data-[state=active]:border-foreground` — that's a different visual problem and stays.

---

## 5. Forms & feedback

- **Form-level errors:** `rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive` banner above the submit row. The convention is consistent across the codebase (`entity-tabs/index.tsx`, `create-entity-sheet.tsx`, `agent-sheets.tsx` — match these).
- **Required fields:** red asterisk on the label (`text-destructive ml-1`).
- **Field-level inline validation:** not used yet. If you add it, document the pattern here so the next person matches it.
- **Async buttons:** `disabled` on `isPending` + text swap (`Save` → `Saving...`). Optional inline `<Loader2 className="animate-spin" />`.
- **Toasts (sonner):** capitalized past-tense — `"Watcher created"`, `"MCP client revoked"`. Not `"Created watcher"`, not `"Watcher has been created."`. **No undo toasts** — the inline two-step confirm is the safety net.
- **Loading states:** prefer skeleton placeholders that mirror the final layout (rows for tables, card outlines for cards). `<TabLoadingState>` from `tab-states.tsx` is the per-tab default. Bare `"Loading..."` text is acceptable only for sub-1-second auth handoffs and tiny inline regions; not for full content panels.

---

## 6. Page headers & lede copy

- The top-of-page description describes the **feature**, not the **layout**.
- **Banned phrases:** `"on the left"`, `"in the sidebar"`, `"above"`, `"below"`, `"from the [position]"`. They break the moment the grid stacks at narrow widths and they teach nothing to a returning user.
- Lede stays under 140 characters. If you need more, the page is doing too much.

---

## 7. Radius & spacing

- **`rounded-2xl`** — Cards only.
- **`rounded-lg`** — every other bordered or filled surface (rows, banners, inputs, empty states, alerts). This is the working standard.
- **`rounded-xl`** — banned. Use `rounded-lg`.
- **Padding:**
  - `p-6` — top-level Card sections (`CardHeader` / `CardContent` already do this).
  - `p-4` — nested bordered boxes inside a Card.
  - `px-3 py-2` — list rows.

---

## 8. Sheet vs Dialog vs inline form

- **`<Sheet>`** (`src/components/ui/sheet.tsx`) — create / edit / configure forms. The default for anything multi-field.
- **`<Dialog>`** (`src/components/ui/dialog.tsx`) — OAuth flows, command palette, short single-purpose modals. Never a destructive confirmation.
- **Inline form** — when the form fits on the page without occluding context (settings sub-sections, etc.).

If you label something `*-dialog.tsx` but use `<Sheet>` underneath, rename the file. Names should match implementation.

---

## 9. Destructive button placement

- **Sheets / pages:** footer right.
- **Inline lists:** trailing action cell.
- **Editors with a "danger zone":** collapsible section at the bottom (see `src/components/settings/entity-types/entity-type-sheet.tsx`).
