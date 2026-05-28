import { describe, expect, mock, test } from "bun:test";

// revolut.ts imports @lobu/connector-sdk (ConnectorRuntime, ...) which pulls in
// the browser stack. Stub it so the pure DOM-parse helpers can be imported
// without spinning up the runtime.
mock.module("@lobu/connector-sdk", () => ({
	ConnectorRuntime: class {},
}));

import {
	buildTransactionsFromDom,
	decideScrollStop,
	filterTransactionsSinceCheckpoint,
	isAuthWall,
	parseAmountString,
	parseRevolutDate,
	type RevolutTransaction,
	STALL_CYCLES,
	transactionToEvent,
} from "../revolut";

describe("parseAmountString", () => {
	test("parses signed GBP/USD/EUR symbols", () => {
		expect(parseAmountString("-£34.13")).toEqual({ amount: -34.13, currency: "GBP" });
		expect(parseAmountString("+£34.13")).toEqual({ amount: 34.13, currency: "GBP" });
		expect(parseAmountString("-$46.15")).toEqual({ amount: -46.15, currency: "USD" });
		expect(parseAmountString("-€1.80")).toEqual({ amount: -1.8, currency: "EUR" });
	});

	test("handles thousands separators (en-GB dot-decimal)", () => {
		expect(parseAmountString("-$1,234.56")).toEqual({
			amount: -1234.56,
			currency: "USD",
		});
	});

	test("handles continental comma-decimal", () => {
		// "1.234,56 zł" → 1234.56 PLN; "1,80 zł" → 1.80 PLN
		expect(parseAmountString("-1.234,56 zł")).toEqual({
			amount: -1234.56,
			currency: "PLN",
		});
		expect(parseAmountString("1,80 zł")).toEqual({ amount: 1.8, currency: "PLN" });
	});

	test("prefers explicit ISO code", () => {
		expect(parseAmountString("-12.00 SEK")).toEqual({ amount: -12, currency: "SEK" });
	});

	test("returns null on unparseable / no-currency input", () => {
		expect(parseAmountString("")).toBeNull();
		expect(parseAmountString("just text")).toBeNull();
		expect(parseAmountString("£")).toBeNull();
	});
});

describe("parseRevolutDate", () => {
	// "now" = 28 May 2026 noon UTC.
	const now = Date.UTC(2026, 4, 28, 12, 0, 0);

	test("bare day heading assumes current year, applies time", () => {
		const d = parseRevolutDate("26 May", "07:18", now);
		expect(d?.toISOString()).toBe("2026-05-26T07:18:00.000Z");
	});

	test("no time → noon UTC anchor", () => {
		const d = parseRevolutDate("3 Jan", "", now);
		expect(d?.toISOString()).toBe("2026-01-03T12:00:00.000Z");
	});

	test("future bare date rolls back to prior year (Dec→Jan boundary)", () => {
		// On 5 Jan, a "20 Dec" heading is last year's December, not this year's.
		const jan = Date.UTC(2026, 0, 5, 12, 0, 0);
		const d = parseRevolutDate("20 Dec", "09:00", jan);
		expect(d?.getUTCFullYear()).toBe(2025);
		expect(d?.getUTCMonth()).toBe(11);
	});

	test("explicit 4-digit year wins", () => {
		const d = parseRevolutDate("15 Feb 2022", "10:57", now);
		expect(d?.toISOString()).toBe("2022-02-15T10:57:00.000Z");
	});

	test("returns null on garbage", () => {
		expect(parseRevolutDate("not a date", "", now)).toBeNull();
	});
});

describe("buildTransactionsFromDom", () => {
	const now = Date.UTC(2026, 4, 28, 12, 0, 0);

	test("maps a card payment row (outgoing)", () => {
		const txns = buildTransactionsFromDom(
			[{ day: "26 May", desc: "O2", amounts: ["-£34.13"], timeRef: "07:18 · D4468637" }],
			now,
		);
		expect(txns).toHaveLength(1);
		expect(txns[0]).toMatchObject({
			description: "O2",
			amount: 34.13,
			direction: "out",
			currency: "GBP",
			date: "2026-05-26",
		});
		expect(txns[0]?.id).toMatch(/^[0-9a-f]{8}$/);
	});

	test("maps an incoming FX row using the primary amount only", () => {
		const txns = buildTransactionsFromDom(
			[
				{
					day: "26 May",
					desc: "Bought GBP with USD",
					amounts: ["+£34.13", "-$46.15"],
					timeRef: "07:18",
				},
			],
			now,
		);
		expect(txns).toHaveLength(1);
		expect(txns[0]).toMatchObject({
			amount: 34.13,
			direction: "in",
			currency: "GBP",
		});
	});

	test("synthesised id is stable for identical rows and differs across rows", () => {
		const a = buildTransactionsFromDom(
			[{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "18:33" }],
			now,
		);
		const b = buildTransactionsFromDom(
			[{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "18:33" }],
			now,
		);
		const c = buildTransactionsFromDom(
			[{ day: "24 May", desc: "Co-op", amounts: ["-£5.50"], timeRef: "18:33" }],
			now,
		);
		expect(a[0]?.id).toBe(b[0]?.id ?? "");
		expect(a[0]?.id).not.toBe(c[0]?.id ?? "");
	});

	test("same day + desc + amount but different time → distinct ids", () => {
		const txns = buildTransactionsFromDom(
			[
				{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "09:00" },
				{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "18:33" },
			],
			now,
		);
		expect(txns).toHaveLength(2);
		expect(txns[0]?.id).not.toBe(txns[1]?.id ?? "");
	});

	test("same minute, same amount, different reference → distinct ids", () => {
		// The full time line carries Revolut's per-transaction reference, so two
		// identical-looking payments in the same minute don't collide.
		const txns = buildTransactionsFromDom(
			[
				{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "18:33 · D1111111" },
				{ day: "24 May", desc: "Co-op", amounts: ["-£4.50"], timeRef: "18:33 · D2222222" },
			],
			now,
		);
		expect(txns).toHaveLength(2);
		expect(txns[0]?.id).not.toBe(txns[1]?.id ?? "");
	});

	test("drops rows missing desc, amount, or date", () => {
		const txns = buildTransactionsFromDom(
			[
				{ day: "24 May", desc: "", amounts: ["-£4.50"], timeRef: "18:33" }, // no desc
				{ day: "24 May", desc: "X", amounts: [], timeRef: "18:33" }, // no amount
				{ day: "garbage", desc: "Y", amounts: ["-£1"], timeRef: "" }, // bad date
				{ day: "24 May", desc: "Z", amounts: ["-£1.00"], timeRef: "01:00" }, // valid
			],
			now,
		);
		expect(txns).toHaveLength(1);
		expect(txns[0]?.description).toBe("Z");
	});
});

describe("filterTransactionsSinceCheckpoint", () => {
	const mk = (id: string, iso: string): RevolutTransaction => ({
		id,
		description: "x",
		amount: 1,
		direction: "out",
		currency: "GBP",
		date: iso.slice(0, 10),
		occurredAt: new Date(iso),
	});

	test("drops at-or-before the checkpoint timestamp and the checkpoint id", () => {
		const txns = [
			mk("c", "2026-05-26T10:00:00Z"),
			mk("b", "2026-05-25T10:00:00Z"),
			mk("a", "2026-05-24T10:00:00Z"),
		];
		const out = filterTransactionsSinceCheckpoint(txns, {
			last_transaction_id: "b",
			last_timestamp: "2026-05-25T10:00:00Z",
		});
		expect(out.map((t) => t.id)).toEqual(["c"]);
	});

	test("dedups by id within a single scrape", () => {
		const txns = [mk("a", "2026-05-26T10:00:00Z"), mk("a", "2026-05-26T10:00:00Z")];
		expect(filterTransactionsSinceCheckpoint(txns, null)).toHaveLength(1);
	});
});

describe("isAuthWall", () => {
	const req = "https://app.revolut.com/transactions";

	test("landed host != requested host (app→sso) is an auth wall", () => {
		expect(isAuthWall(req, "https://sso.revolut.com/passcode?x=1", 0, false)).toBe(true);
	});

	test("zero rows + login form is an auth wall", () => {
		expect(isAuthWall(req, req, 0, true)).toBe(true);
	});

	test("same host with rows is NOT an auth wall", () => {
		expect(isAuthWall(req, req, 12, false)).toBe(false);
	});

	test("same host, zero rows, no form is NOT an auth wall (just empty)", () => {
		expect(isAuthWall(req, req, 0, false)).toBe(false);
	});
});

describe("decideScrollStop (backfill exhaustion + incremental early-stop)", () => {
	test("keeps scrolling while still making progress (no stop)", () => {
		expect(
			decideScrollStop({ stall: 0, oldestDate: "2024-01-01", stopBeforeMs: null, timeUp: false }),
		).toBeNull();
		// One or two stall cycles is not yet the bottom.
		expect(
			decideScrollStop({ stall: STALL_CYCLES - 1, oldestDate: "2024-01-01", stopBeforeMs: null, timeUp: false }),
		).toBeNull();
	});

	test("backfill stops as exhausted after STALL_CYCLES zero-progress cycles", () => {
		expect(
			decideScrollStop({ stall: STALL_CYCLES, oldestDate: "2021-12-01", stopBeforeMs: null, timeUp: false }),
		).toBe("exhausted");
	});

	test("incremental stops once oldest rendered day reaches the checkpoint date", () => {
		const checkpoint = Date.UTC(2026, 4, 20, 10, 0, 0); // 20 May 2026
		// Still newer than the checkpoint → keep going.
		expect(
			decideScrollStop({ stall: 0, oldestDate: "2026-05-25", stopBeforeMs: checkpoint, timeUp: false }),
		).toBeNull();
		// Oldest rendered day is the checkpoint day (end-of-day >= cutoff) → stop.
		expect(
			decideScrollStop({ stall: 0, oldestDate: "2026-05-20", stopBeforeMs: checkpoint, timeUp: false }),
		).toBe("reached_checkpoint");
		// Scrolled a day past it → stop.
		expect(
			decideScrollStop({ stall: 0, oldestDate: "2026-05-19", stopBeforeMs: checkpoint, timeUp: false }),
		).toBe("reached_checkpoint");
	});

	test("time cap fires (capped_time) when the budget is exhausted", () => {
		expect(
			decideScrollStop({ stall: 0, oldestDate: "2024-01-01", stopBeforeMs: null, timeUp: true }),
		).toBe("capped_time");
	});

	test("checkpoint precedence: reached_checkpoint wins over stall + time cap", () => {
		const checkpoint = Date.UTC(2026, 4, 20, 10, 0, 0);
		expect(
			decideScrollStop({ stall: STALL_CYCLES, oldestDate: "2026-05-20", stopBeforeMs: checkpoint, timeUp: true }),
		).toBe("reached_checkpoint");
	});
});

describe("transactionToEvent", () => {
	test("preserves the legacy file-import event shape", () => {
		const evt = transactionToEvent({
			id: "deadbeef",
			description: "O2",
			amount: 34.13,
			direction: "out",
			currency: "GBP",
			date: "2026-05-26",
			occurredAt: new Date("2026-05-26T07:18:00Z"),
		});
		expect(evt.origin_id).toBe("revolut-deadbeef");
		expect(evt.semantic_type).toBe("transaction");
		expect(evt.payload_text).toBe("O2 -£34.13 on 2026-05-26");
		expect(evt.metadata).toMatchObject({
			date: "2026-05-26",
			description: "O2",
			amount: 34.13,
			direction: "out",
			currency: "GBP",
		});
	});
});
