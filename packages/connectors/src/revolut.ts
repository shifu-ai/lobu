/**
 * Revolut Connector
 *
 * Revolut has no public personal-banking API, so this connector reads the
 * RENDERED transaction list from the Revolut web app (`app.revolut.com`) via
 * the paired Owletto Chrome extension — not Revolut's internal
 * `/api/retail/...` JSON. The extension drives the user's real signed-in Chrome
 * session: navigate to the transactions view in a non-disruptive background
 * scrape window, scroll to lazy-load older rows, then extract each transaction
 * straight from the DOM.
 *
 * Why DOM, not network-intercept: Revolut's `app.revolut.com` access token is
 * bound to the browser that minted it (per-request `x-device-id` header +
 * Cloudflare/TLS fingerprint), so replaying its internal API in any other
 * context 401s and bounces to `sso.revolut.com`. Reading what the real session
 * already rendered sidesteps that entirely, and is robust against Revolut
 * rotating/obfuscating those internal endpoints.
 *
 * Visibility: the transaction list is a virtualized DOM (rows recycle out as
 * you scroll) and only paints in a rendered tab — a hidden/background tab never
 * loads it. We navigate with `focus_mode:"window"` (a small, non-focused scrape
 * window that renders without switching the user's tab); if that returns
 * nothing (e.g. fully occluded) we retry once with `bring_to_front`. Because
 * the list virtualizes, we HARVEST rows after every scroll step and accumulate
 * them (deduped) rather than extracting once at the end.
 *
 * Auth is implicit: the user is already signed into app.revolut.com in the
 * paired Chrome. Revolut's session expires often (passcode / SSO re-auth), so
 * if the navigate lands on `sso.revolut.com` (host differs from requested) or a
 * login form with zero rows, we `focus_tab` to surface the tab to the user and
 * throw `RevolutAuthWallError` instead of silently scraping a logged-out page.
 *
 * The emitted event shape matches the original file-import Revolut connector
 * (`semantic_type: "transaction"`, metadata `{ date, description, amount,
 * direction, balance, currency }`) so historical imports stay uniform.
 */

import {
	type ChromeActionDispatcher,
	type ConnectorDefinition,
	ConnectorRuntime,
	type EventEnvelope,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RevolutCheckpoint {
	last_transaction_id?: string;
	last_timestamp?: string;
}

export interface RevolutTransaction {
	id: string;
	description: string;
	/** Absolute value in major currency units (e.g. 20.0 for £20.00). */
	amount: number;
	direction: "in" | "out";
	/** Account balance after the transaction, in major units (may be absent). */
	balance?: number;
	currency: string;
	/** ISO calendar date (YYYY-MM-DD) the transaction settled / started. */
	date: string;
	/** Full settlement timestamp. */
	occurredAt: Date;
	/** Revolut transaction type, e.g. CARD_PAYMENT, TRANSFER, TOPUP. */
	type?: string;
	/** Revolut state, e.g. COMPLETED, PENDING. */
	state?: string;
}

/** A single transaction row scraped from the DOM (before parsing). */
export interface RevolutDomRow {
	/** Day-group heading, e.g. "26 May" or "3 Jan" (no year in the web app). */
	day?: string;
	/** Merchant / description, e.g. "O2", "Bought GBP with USD". */
	desc?: string;
	/** Amount strings as rendered, primary first: e.g. ["-£34.13", "-$46.15"]. */
	amounts?: string[];
	/** Time line, e.g. "07:18" or "07:18 · D4468637". */
	timeRef?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Symbol → ISO 4217. Revolut renders amounts with a leading symbol; we map the
// common ones and fall back to any 3-letter code present in the string.
const SYMBOL_TO_CURRENCY: Record<string, string> = {
	"£": "GBP",
	$: "USD",
	"€": "EUR",
	"¥": "JPY",
	"₹": "INR",
	"₽": "RUB",
	"₺": "TRY",
	"₩": "KRW",
	"₪": "ILS",
	"₴": "UAH",
	"₫": "VND",
	"₱": "PHP",
	"฿": "THB",
	"₦": "NGN",
	R$: "BRL",
	zł: "PLN",
	Fr: "CHF",
};

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	sept: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

/**
 * Parse a rendered amount string like "-£34.13", "+£34.13", "-$1,234.56",
 * "1.234,56 zł" into { amount (signed, major units), currency }.
 *
 * Returns the SIGNED value so callers can derive direction. Handles both
 * thousands/decimal conventions: a comma is a decimal separator only when 1-2
 * digits trail it (e.g. "1,80" vs "1,234").
 */
export function parseAmountString(
	raw: string,
): { amount: number; currency: string } | null {
	const s = (raw ?? "").trim();
	if (!s) return null;

	// Currency: prefer an explicit 3-letter ISO code, else a known symbol.
	let currency: string | null = null;
	const isoMatch = s.match(/\b([A-Z]{3})\b/);
	if (isoMatch) currency = isoMatch[1];
	if (!currency) {
		// Longest symbols first so "R$" beats "$".
		for (const sym of Object.keys(SYMBOL_TO_CURRENCY).sort(
			(a, b) => b.length - a.length,
		)) {
			if (s.includes(sym)) {
				currency = SYMBOL_TO_CURRENCY[sym];
				break;
			}
		}
	}
	if (!currency) return null;

	// Sign: an explicit minus, or a parenthesised negative. Default positive.
	const negative = /-/.test(s) || /^\(.*\)$/.test(s.replace(/\s/g, ""));

	// Strip everything but digits and separators, then normalise to a JS number.
	const numPart = s.replace(/[^\d.,]/g, "");
	if (!numPart) return null;
	let normalised: string;
	const lastComma = numPart.lastIndexOf(",");
	const lastDot = numPart.lastIndexOf(".");
	if (lastComma !== -1 && lastDot !== -1) {
		// Both present: the later one is the decimal separator.
		normalised =
			lastComma > lastDot
				? numPart.replace(/\./g, "").replace(",", ".")
				: numPart.replace(/,/g, "");
	} else if (lastComma !== -1) {
		// Only comma: decimal if 1-2 trailing digits, else thousands.
		const decimals = numPart.length - lastComma - 1;
		normalised =
			decimals === 1 || decimals === 2
				? numPart.replace(",", ".")
				: numPart.replace(/,/g, "");
	} else {
		normalised = numPart;
	}

	const value = Number.parseFloat(normalised);
	if (!Number.isFinite(value)) return null;
	return {
		amount: negative ? -Math.abs(value) : Math.abs(value),
		currency: currency.toUpperCase(),
	};
}

/**
 * Resolve a bare "26 May" / "3 Jan" day heading to a full Date. The web app
 * omits the year on day headings, so we assume the day belongs to the current
 * year; if that lands in the future relative to `now`, it's the prior year
 * (handles the Dec→Jan boundary). An explicit 4-digit year in the heading wins.
 * The time, if present, is applied; otherwise noon UTC (a stable anchor).
 */
export function parseRevolutDate(
	day: string,
	timeRef: string,
	now: number = Date.now(),
): Date | null {
	const dm = (day ?? "").match(/(\d{1,2})\s*([A-Za-z]{3,4})\.?\s*(\d{4})?/);
	if (!dm) return null;
	const dayNum = Number.parseInt(dm[1], 10);
	const month = MONTHS[dm[2].toLowerCase()];
	if (month === undefined || !Number.isFinite(dayNum)) return null;

	const explicitYear = dm[3] ? Number.parseInt(dm[3], 10) : null;
	const tm = (timeRef ?? "").match(/(\d{1,2}):(\d{2})/);
	const hours = tm ? Number.parseInt(tm[1], 10) : 12;
	const minutes = tm ? Number.parseInt(tm[2], 10) : 0;

	let year = explicitYear ?? new Date(now).getUTCFullYear();
	let d = new Date(Date.UTC(year, month, dayNum, hours, minutes, 0));
	if (!explicitYear && d.getTime() > now + 86_400_000) {
		// A future date with no explicit year → it belongs to the prior year.
		year -= 1;
		d = new Date(Date.UTC(year, month, dayNum, hours, minutes, 0));
	}
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Deterministic id for a row that carries no DOM id: hash its stable fields.
 * The basis includes the date, the FULL time line as rendered (which carries
 * Revolut's per-transaction reference, e.g. "07:18 · D4468637", so even two
 * same-merchant/same-amount payments in the same minute get distinct ids), the
 * description, and ALL rendered amounts (the FX source leg disambiguates rows
 * with no reference). This is stable across syncs — the same row always hashes
 * the same — without colliding distinct rows.
 */
function synthesizeId(
	date: string,
	timeRef: string,
	desc: string,
	amounts: string[],
): string {
	const basis = `${date}|${timeRef}|${desc}|${amounts.join("/")}`;
	let h = 2166136261;
	for (let i = 0; i < basis.length; i++) {
		h ^= basis.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Map scraped DOM rows to RevolutTransactions (drops unparseable rows). */
export function buildTransactionsFromDom(
	rows: RevolutDomRow[],
	now: number = Date.now(),
): RevolutTransaction[] {
	const out: RevolutTransaction[] = [];
	for (const r of rows) {
		const desc = (r?.desc ?? "").trim();
		const amounts = Array.isArray(r?.amounts) ? r.amounts : [];
		if (!desc || amounts.length === 0) continue;

		const money = parseAmountString(amounts[0]);
		if (!money) continue;

		const timeRef = (r?.timeRef ?? "").trim();
		const occurredAt = parseRevolutDate(r?.day ?? "", timeRef, now);
		if (!occurredAt) continue;

		const date = occurredAt.toISOString().slice(0, 10);
		out.push({
			id: synthesizeId(date, timeRef, desc, amounts),
			description: desc,
			amount: Math.abs(money.amount),
			direction: money.amount < 0 ? "out" : "in",
			currency: money.currency,
			date,
			occurredAt,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Checkpoint filtering
// ---------------------------------------------------------------------------

export function filterTransactionsSinceCheckpoint(
	transactions: RevolutTransaction[],
	checkpoint: RevolutCheckpoint | null | undefined,
): RevolutTransaction[] {
	const lastTs = checkpoint?.last_timestamp
		? new Date(checkpoint.last_timestamp).getTime()
		: null;
	const lastId = checkpoint?.last_transaction_id;
	const seen = new Set<string>();
	return transactions.filter((t) => {
		if (seen.has(t.id)) return false;
		seen.add(t.id);
		if (lastId && t.id === lastId) return false;
		if (
			lastTs !== null &&
			Number.isFinite(lastTs) &&
			t.occurredAt.getTime() <= lastTs
		) {
			return false;
		}
		return true;
	});
}

// ---------------------------------------------------------------------------
// Event mapping (matches the original file-import Revolut connector)
// ---------------------------------------------------------------------------

function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "GBP":
			return "£";
		case "USD":
			return "$";
		case "EUR":
			return "€";
		default:
			return `${currency} `;
	}
}

export function transactionToEvent(t: RevolutTransaction): EventEnvelope {
	const sign = t.direction === "out" ? "-" : "+";
	return {
		origin_id: `revolut-${t.id}`,
		payload_text: `${t.description} ${sign}${currencySymbol(t.currency)}${t.amount} on ${t.date}`,
		occurred_at: t.occurredAt,
		semantic_type: "transaction",
		metadata: {
			date: t.date,
			description: t.description,
			amount: t.amount,
			direction: t.direction,
			...(t.balance !== undefined ? { balance: t.balance } : {}),
			currency: t.currency,
			...(t.type ? { transaction_type: t.type } : {}),
			...(t.state ? { state: t.state } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Extension dispatch + auth-wall handling
// ---------------------------------------------------------------------------

/**
 * Pull the chrome action dispatcher from sessionState. The connector-worker
 * subprocess splices a live `chrome_dispatcher` onto every sync's sessionState;
 * its `dispatch()` rides IPC → daemon → the gateway chrome-action bridge → the
 * paired Owletto extension. With no online extension in the connection's org,
 * the bridge returns `failed` and the dispatcher throws — surfaced verbatim.
 */
function requireExtensionDispatcher(ctx: SyncContext): ChromeActionDispatcher {
	const handle = (ctx.sessionState as Record<string, unknown> | null | undefined)
		?.chrome_dispatcher as ChromeActionDispatcher | undefined;
	if (!handle || typeof handle.dispatch !== "function") {
		throw new Error(
			"Revolut connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge.",
		);
	}
	return handle;
}

/** Raised when the scrape lands on Revolut's passcode / SSO sign-in wall. */
export class RevolutAuthWallError extends Error {
	constructor(landedUrl: string) {
		super(
			`Revolut session needs sign-in (redirected to ${landedUrl}). The scrape tab was focused so you can re-enter your passcode; the next sync will use the authenticated session.`,
		);
		this.name = "RevolutAuthWallError";
	}
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Deterministic auth-wall detection. Revolut bounces an expired session from
 * `app.revolut.com` to `sso.revolut.com/passcode` (or `/signin`), so the
 * primary signal is the LANDED host differing from the REQUESTED host. As a
 * backstop, a page that rendered zero transaction rows AND shows a login form
 * (password / passcode input) is also an auth wall. We do NOT rely on URL
 * keywords alone — the host comparison catches the app→sso redirect cleanly.
 */
export function isAuthWall(
	requestedUrl: string,
	landedUrl: string,
	rowCount: number,
	hasLoginForm: boolean,
): boolean {
	const reqHost = hostOf(requestedUrl);
	const landedHost = hostOf(landedUrl);
	if (reqHost && landedHost && landedHost !== reqHost) return true;
	if (rowCount === 0 && hasLoginForm) return true;
	return false;
}

// ---------------------------------------------------------------------------
// DOM scrape (runs in-page via the extension's `evaluate` op)
// ---------------------------------------------------------------------------

// The Revolut transaction list is virtualized: rows recycle out of the DOM as
// you scroll, so we accumulate on `window.__lobuRevTxns` across calls and dedup
// by a content key. Each transaction is a <button> inside a
// `div[role="transactions-group"]` (one group per day; the group's first text
// line is the day heading). A button's lines are
//   [merchant/description, "HH:MM[ · ref]", "<sign><sym><amount>", ...fx].
// `[class*=ItemTitle]` carries the clean merchant name.
const HARVEST_EXPRESSION = `
(() => {
  const W = window;
  W.__lobuRevTxns = W.__lobuRevTxns || {};
  const acc = W.__lobuRevTxns;
  const groups = [...document.querySelectorAll('[role="transactions-group"]')];
  for (const g of groups) {
    const day = (g.innerText || '').split('\\n')[0].trim();
    let ord = 0;
    for (const b of g.querySelectorAll('button')) {
      const lines = b.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const amounts = lines.filter(l => /[£$€¥₹₽₺₩₪₴₫₱฿₦]|\\b[A-Z]{3}\\b/.test(l) && /\\d/.test(l));
      if (!amounts.length) continue;
      const titleEl = b.querySelector('[class*="ItemTitle"]');
      const desc = titleEl ? titleEl.innerText.trim() : lines[0];
      const timeRef = lines.find(l => /^\\d{1,2}:\\d{2}/.test(l)) || '';
      const key = day + '|' + desc + '|' + amounts.join('/') + '|' + timeRef + '|' + (ord++);
      if (!acc[key]) acc[key] = { day: day, desc: desc, amounts: amounts, timeRef: timeRef };
    }
  }
  return Object.keys(acc).length;
})()
`;

/**
 * One scroll cycle: scroll to the bottom to lazy-load older rows, HARVEST the
 * newly-rendered rows into the in-page accumulator (dedup), then return the
 * running accumulated-row count and the OLDEST day heading now rendered
 * (`YYYY-MM-DD`, resolved with the same year inference as the parser). Folding
 * the harvest in keeps the loop to one `evaluate` per cycle. The oldest-day
 * signal lets an incremental sync stop once it has scrolled back past the
 * checkpoint date.
 */
const SCROLL_CYCLE_EXPRESSION = `
(async () => {
  window.scrollTo(0, document.body.scrollHeight);
  if (document.scrollingElement) document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
  await new Promise(r => setTimeout(r, 1500));

  // Harvest (same logic as HARVEST_EXPRESSION) into the shared accumulator.
  const W = window;
  W.__lobuRevTxns = W.__lobuRevTxns || {};
  const acc = W.__lobuRevTxns;
  const groups = [...document.querySelectorAll('[role="transactions-group"]')];
  for (const g of groups) {
    const day = (g.innerText || '').split('\\n')[0].trim();
    let ord = 0;
    for (const b of g.querySelectorAll('button')) {
      const lines = b.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const amounts = lines.filter(l => /[£$€¥₹₽₺₩₪₴₫₱฿₦]|\\b[A-Z]{3}\\b/.test(l) && /\\d/.test(l));
      if (!amounts.length) continue;
      const titleEl = b.querySelector('[class*="ItemTitle"]');
      const desc = titleEl ? titleEl.innerText.trim() : lines[0];
      const timeRef = lines.find(l => /^\\d{1,2}:\\d{2}/.test(l)) || '';
      const key = day + '|' + desc + '|' + amounts.join('/') + '|' + timeRef + '|' + (ord++);
      if (!acc[key]) acc[key] = { day: day, desc: desc, amounts: amounts, timeRef: timeRef };
    }
  }

  // Oldest rendered day = last group's heading. Resolve its year the same way
  // the connector's parser does (current year, rolling back if future).
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
  const resolveDay = (heading) => {
    const m = (heading || '').match(/(\\d{1,2})\\s*([A-Za-z]{3,4})\\.?\\s*(\\d{4})?/);
    if (!m) return null;
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(m[1], 10);
    const now = Date.now();
    let year = m[3] ? parseInt(m[3], 10) : new Date(now).getUTCFullYear();
    let d = Date.UTC(year, month, day, 12, 0, 0);
    if (!m[3] && d > now + 86400000) d = Date.UTC(year - 1, month, day, 12, 0, 0);
    return new Date(d).toISOString().slice(0, 10);
  };
  const oldestHead = groups.length ? (groups[groups.length - 1].innerText || '').split('\\n')[0].trim() : '';
  return JSON.stringify({ accCount: Object.keys(acc).length, renderedButtons: document.querySelectorAll('[role="transactions-group"] button').length, oldestDate: resolveDay(oldestHead) });
})()
`;

/** Read the accumulated rows out of the page and clear the accumulator. */
const COLLECT_EXPRESSION = `
(() => {
  const acc = window.__lobuRevTxns || {};
  const rows = Object.values(acc);
  window.__lobuRevTxns = {};
  return rows;
})()
`;

/** Probe whether the landed page is a login wall (URL + login-form presence). */
const PROBE_EXPRESSION = `
JSON.stringify({
  url: location.href,
  rowCount: document.querySelectorAll('[role="transactions-group"] button').length,
  hasLoginForm: !!document.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
})
`;

interface ProbeResult {
	url: string;
	rowCount: number;
	hasLoginForm: boolean;
}

interface ScrollProgress {
	accCount: number;
	renderedButtons: number;
	oldestDate: string | null;
}

/** How the scroll loop terminated, surfaced in sync metadata + logs. */
export type ScrapeStopReason =
	| "exhausted" // hit the bottom of history (stall)
	| "reached_checkpoint" // scrolled back past the last-seen txn (incremental)
	| "capped_cycles" // safety cap on scroll iterations
	| "capped_time"; // wall-clock budget exhausted

export interface ScrapeResult {
	rows: RevolutDomRow[];
	stopReason: ScrapeStopReason;
	cycles: number;
	/** Oldest day heading reached (`YYYY-MM-DD`), or null if nothing rendered. */
	oldestDate: string | null;
}

// Backfill safety rails: a first full-history sync can be multi-minute, but it
// must never loop forever. STALL_CYCLES consecutive zero-new-row scrolls means
// the bottom; MAX_SCROLL_CYCLES / TIME_BUDGET_MS are hard ceilings.
export const STALL_CYCLES = 3;
const MAX_SCROLL_CYCLES = 300;
const TIME_BUDGET_MS = 4 * 60_000;

/** Per-cycle inputs the stop decision is made from. */
export interface ScrollCycleState {
	/** Consecutive zero-progress cycles, INCLUDING this one if it added nothing. */
	stall: number;
	/** Oldest day reached so far (`YYYY-MM-DD`), or null. */
	oldestDate: string | null;
	/** Incremental checkpoint cutoff (ms epoch), or null for a full backfill. */
	stopBeforeMs: number | null;
	/** True once the wall-clock budget is exhausted. */
	timeUp: boolean;
}

/**
 * Pure stop decision for one scroll cycle (unit-tested). Returns the stop
 * reason if the loop should halt, or null to keep scrolling.
 *
 * Precedence: reached the checkpoint date (incremental) → time cap → stall
 * (exhausted bottom). The cycle cap is handled by the loop bound itself.
 */
export function decideScrollStop(
	state: ScrollCycleState,
): ScrapeStopReason | null {
	if (
		state.stopBeforeMs !== null &&
		state.oldestDate &&
		// The oldest rendered DAY is at/before the checkpoint's day. Compare at
		// start-of-day so reaching the checkpoint's own day (regardless of the
		// checkpoint's intra-day time) counts as "scrolled back far enough" —
		// filterTransactionsSinceCheckpoint then drops anything actually older.
		new Date(`${state.oldestDate}T00:00:00Z`).getTime() <=
			new Date(new Date(state.stopBeforeMs).toISOString().slice(0, 10)).getTime()
	) {
		return "reached_checkpoint";
	}
	if (state.timeUp) return "capped_time";
	if (state.stall >= STALL_CYCLES) return "exhausted";
	return null;
}

/**
 * The scroll-until-stop core. Harvests the initial view, then repeatedly
 * scrolls + harvests + accumulates (dedup) in-page until one of:
 *  - `STALL_CYCLES` consecutive cycles add ZERO new rows → "exhausted" (bottom).
 *  - (incremental) the oldest rendered day is at/before `stopBeforeMs` → we've
 *    scrolled back past the checkpoint, so stop → "reached_checkpoint".
 *  - the scroll-cycle cap is hit → "capped_cycles".
 *  - the wall-clock budget is exhausted → "capped_time".
 *
 * Returns the collected rows plus how it stopped + how far back it reached.
 */
async function scrollUntilStop(
	dispatcher: ChromeActionDispatcher,
	tabId: number,
	maxCycles: number,
	stopBeforeMs: number | null,
	now: number = Date.now(),
): Promise<ScrapeResult> {
	// Harvest the initial view before scrolling so day-zero rows aren't missed.
	await dispatcher.dispatch("evaluate", { tab_id: tabId, expression: HARVEST_EXPRESSION });

	const deadline = now + TIME_BUDGET_MS;
	let prevCount = 0;
	let stall = 0;
	let cycles = 0;
	let oldestDate: string | null = null;
	let stopReason: ScrapeStopReason = "capped_cycles";

	while (cycles < maxCycles) {
		cycles++;
		// One round-trip: scroll → harvest → report (count + oldest day).
		const res = await dispatcher.dispatch<{ value?: unknown }>("evaluate", {
			tab_id: tabId,
			expression: SCROLL_CYCLE_EXPRESSION,
		});
		let progress: ScrollProgress = { accCount: prevCount, renderedButtons: 0, oldestDate };
		try {
			if (typeof res?.value === "string") progress = JSON.parse(res.value) as ScrollProgress;
		} catch {
			// Keep prior progress on a parse failure.
		}
		if (progress.oldestDate) oldestDate = progress.oldestDate;
		const count = progress.accCount;

		stall = count > prevCount ? 0 : stall + 1;
		prevCount = count;

		const decision = decideScrollStop({
			stall,
			oldestDate,
			stopBeforeMs,
			timeUp: Date.now() >= deadline,
		});
		if (decision) {
			stopReason = decision;
			break;
		}
		// Reached the cycle cap without stopping → capped_cycles (loop default).
	}

	const collected = await dispatcher.dispatch<{ value?: unknown }>("evaluate", {
		tab_id: tabId,
		expression: COLLECT_EXPRESSION,
	});
	const rows = Array.isArray(collected?.value)
		? (collected.value as RevolutDomRow[])
		: [];
	return { rows, stopReason, cycles, oldestDate };
}

/**
 * Render the Revolut transactions page in the paired Chrome and scrape rows.
 *
 * Tries `focus_mode:"window"` first (a background scrape window that renders
 * without switching the user's tab); if it yields nothing — the signature of a
 * fully-occluded background window Chrome throttled — retries once with
 * `bring_to_front`. The window stays open for the whole scroll loop (a
 * first-time full backfill can take minutes; that's a one-time cost).
 *
 * `stopBeforeMs` drives backfill vs incremental:
 *  - null (no checkpoint) → full backfill: scroll until the history bottom
 *    (stall) or a safety cap.
 *  - a timestamp (checkpoint set) → incremental: scroll only until the oldest
 *    rendered day reaches that date, then stop.
 *
 * On an auth wall (landed host != requested, or zero rows + a login form) we
 * `focus_tab` to surface the tab so the user can re-enter their passcode, then
 * throw `RevolutAuthWallError` — never silently scraping a logged-out page.
 */
async function scrapeTransactionRows(
	dispatcher: ChromeActionDispatcher,
	url: string,
	maxCycles: number,
	stopBeforeMs: number | null,
): Promise<ScrapeResult> {
	const modes: Array<Record<string, unknown>> = [
		{ focus_mode: "window" },
		{ bring_to_front: true },
	];
	let last: ScrapeResult = { rows: [], stopReason: "exhausted", cycles: 0, oldestDate: null };
	for (const mode of modes) {
		const nav = await dispatcher.dispatch<{ tab_id: number; current_url?: string }>(
			"navigate",
			{
				url,
				open_in_new_tab: true,
				wait_for_load: true,
				allowed_origins: ["revolut.com", "*.revolut.com", "app.revolut.com"],
				...mode,
			},
		);
		const tabId = nav.tab_id;

		// Probe the landed page for an auth wall before scraping.
		let probe: ProbeResult = {
			url: String(nav.current_url ?? url),
			rowCount: 0,
			hasLoginForm: false,
		};
		try {
			const res = await dispatcher.dispatch<{ value?: unknown }>("evaluate", {
				tab_id: tabId,
				expression: PROBE_EXPRESSION,
			});
			if (typeof res?.value === "string") {
				probe = JSON.parse(res.value) as ProbeResult;
			}
		} catch {
			// Probe failure: fall back to the navigate-reported URL.
		}

		if (isAuthWall(url, probe.url, probe.rowCount, probe.hasLoginForm)) {
			try {
				await dispatcher.dispatch("focus_tab", { tab_id: tabId });
			} catch {
				// focus_tab may be unavailable on older extensions; best-effort
				// foreground so the tab is at least visible for re-auth.
				try {
					await dispatcher.dispatch("navigate", {
						tab_id: tabId,
						url: probe.url,
						open_in_new_tab: false,
						bring_to_front: true,
						wait_for_load: false,
					});
				} catch {}
			}
			throw new RevolutAuthWallError(probe.url);
		}

		try {
			last = await scrollUntilStop(dispatcher, tabId, maxCycles, stopBeforeMs);
			if (last.rows.length > 0) return last;
			// Empty: likely the background window was occluded → try the next mode.
		} finally {
			try {
				await dispatcher.dispatch("close_tab", { tab_id: tabId });
			} catch {
				// best-effort; the stale-tab reaper backstops a missed close.
			}
		}
	}
	return last;
}

// ---------------------------------------------------------------------------
// Config + connector definition
// ---------------------------------------------------------------------------

// `/transactions` shows the full, scrollable history for the default account;
// `/home` only shows the latest ~10. Per-pocket history lives at
// `/transactions?accountType=pocket&walletId=<uuid>&pocketId=<uuid>` — point a
// second feed's `start_url` there to sync a non-default currency pocket.
const DEFAULT_START_URL = "https://app.revolut.com/transactions";

const configSchema = {
	type: "object",
	properties: {
		start_url: {
			type: "string",
			default: DEFAULT_START_URL,
			description:
				"Revolut web app URL to open. Defaults to the full transactions view for the primary account; set it to a per-pocket /transactions?...pocketId=<uuid> URL to sync a different currency pocket.",
		},
		currency_filter: {
			type: "string",
			description:
				'If set, keep only transactions in this ISO 4217 currency (e.g. "GBP").',
		},
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 300,
			default: 300,
			description:
				"Safety cap on scroll iterations. The first sync (no checkpoint) backfills ALL history — scrolling until the bottom (3 consecutive empty cycles) or this cap / a ~4-minute budget. Later syncs stop at the last-seen transaction. Lower it only to bound a one-off run.",
		},
	},
};

const transactionMetadataSchema = {
	type: "object",
	properties: {
		date: { type: "string", format: "date" },
		description: { type: "string" },
		amount: { type: "number" },
		direction: { type: "string", enum: ["in", "out"] },
		balance: { type: "number" },
		currency: { type: "string" },
		transaction_type: { type: "string" },
		state: { type: "string" },
	},
};

export default class RevolutConnector extends ConnectorRuntime {
	readonly definition: ConnectorDefinition = {
		key: "revolut",
		name: "Revolut",
		description:
			"Syncs Revolut account transactions by reading the rendered Revolut web app (no public API) through your paired Owletto Chrome session — no separate login, robust against Revolut's rotating internal API.",
		version: "3.0.0",
		faviconDomain: "app.revolut.com",
		authSchema: {
			// Auth is implicit via the paired Owletto extension's signed-in Chrome —
			// no CDP, no cookie capture. Revolut's session expires periodically; when
			// it does the sync surfaces the scrape tab (focus_tab) and fails with a
			// "needs sign-in" message so the user can re-enter their passcode.
			methods: [{ type: "none" }],
		},
		feeds: {
			transactions: {
				key: "transactions",
				name: "Transactions",
				description: "Account transactions read from the Revolut web app DOM.",
				configSchema,
				eventKinds: {
					transaction: {
						description: "A bank transaction",
						metadataSchema: transactionMetadataSchema,
					},
				},
			},
		},
		optionsSchema: configSchema,
	};

	async sync(ctx: SyncContext): Promise<SyncResult> {
		const config = (ctx.config ?? {}) as Record<string, unknown>;
		const checkpoint = (ctx.checkpoint ?? {}) as RevolutCheckpoint;
		const dispatcher = requireExtensionDispatcher(ctx);

		const startUrl =
			typeof config.start_url === "string" && config.start_url.trim()
				? config.start_url.trim()
				: DEFAULT_START_URL;
		const currencyFilter =
			typeof config.currency_filter === "string" && config.currency_filter.trim()
				? config.currency_filter.trim().toUpperCase()
				: null;
		const maxScrolls = Math.max(
			1,
			Math.min(MAX_SCROLL_CYCLES, Number(config.max_scrolls ?? MAX_SCROLL_CYCLES) || MAX_SCROLL_CYCLES),
		);

		// First sync (no checkpoint) → full backfill: scroll until the history
		// bottom. Subsequent syncs → incremental: stop once we've scrolled back
		// past the last-seen transaction's date.
		const stopBeforeMs = checkpoint.last_timestamp
			? new Date(checkpoint.last_timestamp).getTime()
			: null;
		const isBackfill = stopBeforeMs === null;

		const scrape = await scrapeTransactionRows(
			dispatcher,
			startUrl,
			maxScrolls,
			Number.isFinite(stopBeforeMs as number) ? (stopBeforeMs as number) : null,
		);
		const all = buildTransactionsFromDom(scrape.rows);

		let transactions = filterTransactionsSinceCheckpoint(all, checkpoint);
		if (currencyFilter) {
			transactions = transactions.filter((t) => t.currency === currencyFilter);
		}
		transactions.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

		// Loudly note a capped backfill — we did NOT reach the bottom, so the
		// oldest history is missing and a follow-up run is needed. Surfaced both
		// here (worker run log) and in metadata.history_complete below; never a
		// silent truncation.
		const capped =
			scrape.stopReason === "capped_cycles" || scrape.stopReason === "capped_time";
		if (capped) {
			console.warn(
				`[revolut] backfill hit the ${scrape.stopReason === "capped_time" ? "time" : "scroll"} cap after ${scrape.cycles} cycles; reached back to ${scrape.oldestDate ?? "unknown"} but did NOT exhaust history. Re-run to continue from this point.`,
			);
		}

		const events: EventEnvelope[] = transactions.map(transactionToEvent);
		const newest = transactions[0];
		const newCheckpoint: RevolutCheckpoint = newest
			? {
					last_transaction_id: newest.id,
					last_timestamp: newest.occurredAt.toISOString(),
				}
			: checkpoint;

		return {
			events,
			checkpoint: newCheckpoint as unknown as Record<string, unknown>,
			metadata: {
				items_found: events.length,
				items_scraped: scrape.rows.length,
				backend: "extension-dom",
				mode: isBackfill ? "backfill" : "incremental",
				stop_reason: scrape.stopReason,
				scroll_cycles: scrape.cycles,
				oldest_date_reached: scrape.oldestDate,
				history_complete: scrape.stopReason !== "capped_cycles" && scrape.stopReason !== "capped_time",
				...(currencyFilter ? { currency_filter: currencyFilter } : {}),
			},
		};
	}
}
