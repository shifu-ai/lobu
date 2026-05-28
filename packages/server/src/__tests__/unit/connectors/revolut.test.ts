import { describe, expect, it } from "vitest";
import {
	buildTransactionsFromDom,
	filterTransactionsSinceCheckpoint,
	type RevolutTransaction,
	transactionToEvent,
} from "../../../../../connectors/src/revolut";

// The Revolut connector reads the rendered transaction list from the
// app.revolut.com DOM via the Owletto extension (no network-intercept). These
// tests exercise the DOM-row parser end-to-end through buildTransactionsFromDom.

describe("Revolut DOM-row parsing", () => {
	// "now" = 28 May 2026 noon UTC, so bare day headings resolve to 2026.
	const now = Date.UTC(2026, 4, 28, 12, 0, 0);

	it("parses a card payment (outgoing) and a top-up (incoming)", () => {
		const txns = buildTransactionsFromDom(
			[
				{
					day: "26 May",
					desc: "The Chancellors",
					amounts: ["-£20.00"],
					timeRef: "12:01 · D4468637",
				},
				{ day: "26 May", desc: "Apple Pay top-up", amounts: ["+£50.00"], timeRef: "12:05" },
			],
			now,
		);
		expect(txns).toHaveLength(2);
		expect(txns[0]).toMatchObject({
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			currency: "GBP",
			date: "2026-05-26",
		});
		expect(txns[1]).toMatchObject({
			description: "Apple Pay top-up",
			amount: 50,
			direction: "in",
			currency: "GBP",
		});
	});

	it("uses the primary amount for FX rows (ignores the source-currency leg)", () => {
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
		expect(txns[0]).toMatchObject({ amount: 34.13, direction: "in", currency: "GBP" });
	});

	it("synthesised id distinguishes same-day/same-amount rows by time", () => {
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

	it("skips rows missing description, amount, or a parseable date", () => {
		const txns = buildTransactionsFromDom(
			[
				{ day: "24 May", desc: "", amounts: ["-£4.50"], timeRef: "18:33" },
				{ day: "24 May", desc: "X", amounts: [], timeRef: "18:33" },
				{ day: "garbage", desc: "Y", amounts: ["-£1.00"], timeRef: "" },
				{ day: "24 May", desc: "Z", amounts: ["-£1.00"], timeRef: "01:00" },
			],
			now,
		);
		expect(txns).toHaveLength(1);
		expect(txns[0]?.description).toBe("Z");
	});
});

describe("Revolut checkpoint filtering", () => {
	const make = (id: string, iso: string): RevolutTransaction => ({
		id,
		description: id,
		amount: 1,
		direction: "out",
		currency: "GBP",
		date: iso.slice(0, 10),
		occurredAt: new Date(iso),
	});

	it("drops transactions at or before the saved timestamp and dedups by id", () => {
		const txns = [
			make("103", "2026-03-29T12:00:00.000Z"),
			make("102", "2026-03-28T12:00:00.000Z"),
			make("102", "2026-03-28T12:00:00.000Z"),
			make("101", "2026-03-27T12:00:00.000Z"),
		];
		expect(
			filterTransactionsSinceCheckpoint(txns, {
				last_transaction_id: "102",
				last_timestamp: "2026-03-28T12:00:00.000Z",
			}).map((t) => t.id),
		).toEqual(["103"]);
	});

	it("returns everything when there is no checkpoint", () => {
		const txns = [
			make("2", "2026-03-29T12:00:00.000Z"),
			make("1", "2026-03-28T12:00:00.000Z"),
		];
		expect(
			filterTransactionsSinceCheckpoint(txns, null).map((t) => t.id),
		).toEqual(["2", "1"]);
	});
});

describe("Revolut event mapping", () => {
	it("produces the legacy event shape", () => {
		const event = transactionToEvent({
			id: "tx_1",
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			balance: 17405.89,
			currency: "GBP",
			date: "2024-06-30",
			occurredAt: new Date("2024-06-30T12:01:00.000Z"),
			type: "CARD_PAYMENT",
			state: "COMPLETED",
		});
		expect(event.origin_id).toBe("revolut-tx_1");
		expect(event.semantic_type).toBe("transaction");
		expect(event.payload_text).toBe("The Chancellors -£20 on 2024-06-30");
		expect(event.metadata).toMatchObject({
			date: "2024-06-30",
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			balance: 17405.89,
			currency: "GBP",
			transaction_type: "CARD_PAYMENT",
			state: "COMPLETED",
		});
	});
});
