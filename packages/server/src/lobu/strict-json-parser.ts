const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_VALUES = 20_000;

export class StrictJsonError extends Error {
	constructor(
		readonly code: "invalid_json" | "duplicate_json_member",
		message: string,
	) {
		super(message);
		this.name = "StrictJsonError";
	}
}

/**
 * Parses a bounded UTF-8 JSON body while rejecting duplicate decoded object
 * member names. JSON.parse cannot detect duplicates because it overwrites the
 * earlier member before application validation can inspect it.
 */
export function parseStrictJsonBytes(
	bytes: Uint8Array,
	limits: {
		maxBytes?: number;
		maxDepth?: number;
		maxValues?: number;
	} = {},
): unknown {
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	if (bytes.byteLength > maxBytes) {
		throw invalidJson(`JSON body exceeds ${maxBytes} bytes`);
	}
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw invalidJson("JSON body is not valid UTF-8");
	}
	return new StrictJsonParser(
		source,
		limits.maxDepth ?? DEFAULT_MAX_DEPTH,
		limits.maxValues ?? DEFAULT_MAX_VALUES,
	).parse();
}

class StrictJsonParser {
	private index = 0;
	private valueCount = 0;

	constructor(
		private readonly source: string,
		private readonly maxDepth: number,
		private readonly maxValues: number,
	) {}

	parse(): unknown {
		this.skipWhitespace();
		const value = this.parseValue(0);
		this.skipWhitespace();
		if (this.index !== this.source.length) {
			throw this.invalidAt("Unexpected content after the top-level JSON value");
		}
		return value;
	}

	private parseValue(depth: number): unknown {
		if (depth > this.maxDepth) {
			throw this.invalidAt(`JSON nesting exceeds ${this.maxDepth}`);
		}
		this.valueCount += 1;
		if (this.valueCount > this.maxValues) {
			throw this.invalidAt(`JSON value count exceeds ${this.maxValues}`);
		}
		const character = this.source[this.index];
		switch (character) {
			case "{":
				return this.parseObject(depth + 1);
			case "[":
				return this.parseArray(depth + 1);
			case '"':
				return this.parseString();
			case "t":
				return this.parseLiteral("true", true);
			case "f":
				return this.parseLiteral("false", false);
			case "n":
				return this.parseLiteral("null", null);
			default:
				if (character === "-" || isDigit(character)) return this.parseNumber();
				throw this.invalidAt("Expected a JSON value");
		}
	}

	private parseObject(depth: number): Record<string, unknown> {
		this.index += 1;
		this.skipWhitespace();
		const result = Object.create(null) as Record<string, unknown>;
		const members = new Set<string>();
		if (this.consume("}")) return result;

		while (true) {
			if (this.source[this.index] !== '"') {
				throw this.invalidAt("Expected a quoted JSON object member name");
			}
			const key = this.parseString();
			if (members.has(key)) {
				throw new StrictJsonError(
					"duplicate_json_member",
					`Duplicate JSON object member at offset ${this.index}: ${key}`,
				);
			}
			members.add(key);
			this.skipWhitespace();
			this.expect(":");
			this.skipWhitespace();
			const value = this.parseValue(depth);
			Object.defineProperty(result, key, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			this.skipWhitespace();
			if (this.consume("}")) return result;
			this.expect(",");
			this.skipWhitespace();
		}
	}

	private parseArray(depth: number): unknown[] {
		this.index += 1;
		this.skipWhitespace();
		const result: unknown[] = [];
		if (this.consume("]")) return result;

		while (true) {
			result.push(this.parseValue(depth));
			this.skipWhitespace();
			if (this.consume("]")) return result;
			this.expect(",");
			this.skipWhitespace();
		}
	}

	private parseString(): string {
		this.expect('"');
		let result = "";
		while (this.index < this.source.length) {
			const character = this.source[this.index];
			this.index += 1;
			if (character === '"') return result;
			if (character === "\\") {
				result += this.parseEscape();
				continue;
			}
			if (character.charCodeAt(0) < 0x20) {
				throw this.invalidAt("Unescaped control character in JSON string");
			}
			result += character;
		}
		throw this.invalidAt("Unterminated JSON string");
	}

	private parseEscape(): string {
		const escaped = this.source[this.index];
		this.index += 1;
		switch (escaped) {
			case '"':
			case "\\":
			case "/":
				return escaped;
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "u": {
				const digits = this.source.slice(this.index, this.index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
					throw this.invalidAt("Invalid JSON Unicode escape");
				}
				this.index += 4;
				return String.fromCharCode(Number.parseInt(digits, 16));
			}
			default:
				throw this.invalidAt("Invalid JSON string escape");
		}
	}

	private parseNumber(): number {
		const start = this.index;
		if (this.consume("-")) {
			if (this.index >= this.source.length)
				throw this.invalidAt("Incomplete JSON number");
		}
		if (this.consume("0")) {
			if (isDigit(this.source[this.index])) {
				throw this.invalidAt("JSON number cannot contain a leading zero");
			}
		} else {
			this.requireDigits("Expected digits in JSON number");
		}
		if (this.consume(".")) {
			this.requireDigits("JSON number fraction requires digits");
		}
		if (this.source[this.index] === "e" || this.source[this.index] === "E") {
			this.index += 1;
			if (this.source[this.index] === "+" || this.source[this.index] === "-") {
				this.index += 1;
			}
			this.requireDigits("JSON number exponent requires digits");
		}
		const value = Number(this.source.slice(start, this.index));
		if (!Number.isFinite(value))
			throw this.invalidAt("JSON number is outside finite range");
		return value;
	}

	private requireDigits(message: string): void {
		const start = this.index;
		while (isDigit(this.source[this.index])) this.index += 1;
		if (start === this.index) throw this.invalidAt(message);
	}

	private parseLiteral<T>(literal: string, value: T): T {
		if (
			this.source.slice(this.index, this.index + literal.length) !== literal
		) {
			throw this.invalidAt(`Invalid JSON literal; expected ${literal}`);
		}
		this.index += literal.length;
		return value;
	}

	private skipWhitespace(): void {
		while (
			this.source[this.index] === " " ||
			this.source[this.index] === "\t" ||
			this.source[this.index] === "\n" ||
			this.source[this.index] === "\r"
		) {
			this.index += 1;
		}
	}

	private expect(character: string): void {
		if (!this.consume(character)) {
			throw this.invalidAt(`Expected ${JSON.stringify(character)}`);
		}
	}

	private consume(character: string): boolean {
		if (this.source[this.index] !== character) return false;
		this.index += 1;
		return true;
	}

	private invalidAt(message: string): StrictJsonError {
		return invalidJson(`${message} at offset ${this.index}`);
	}
}

function isDigit(character: string | undefined): boolean {
	return character !== undefined && character >= "0" && character <= "9";
}

function invalidJson(message: string): StrictJsonError {
	return new StrictJsonError("invalid_json", message);
}
