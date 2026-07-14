import { TOOL_PRIORITY_WEIGHT } from "./tool-catalog";
import { inventoryFingerprint, type ToolDescriptor } from "./tool-descriptor";
import { normalizeToolText, tokenizeToolText } from "./tool-tokenizer";

const DEFAULT_MAX_INDEX_BYTES = 16 * 1024 * 1024;
const SCORE_TIE_EPSILON = 1e-9;
// These are intentionally conservative accounting allowances, not claims about
// exact V8 heap layout. Serialized UTF-8 payload is doubled for string storage,
// then explicit collection/object overhead is added for retained structures.
const SERIALIZED_PAYLOAD_MULTIPLIER = 2;
const MAP_ENTRY_OVERHEAD_BYTES = 48;
const DESCRIPTOR_OBJECT_OVERHEAD_BYTES = 256;
const ARRAY_OBJECT_OVERHEAD_BYTES = 32;

export interface ToolCandidateMatch {
	descriptor: ToolDescriptor;
	totalScore: number;
	scoreBreakdown: {
		exactName: number;
		nameTitle: number;
		aliasesExamples: number;
		description: number;
		parameters: number;
		domain: number;
		negativePenalty: number;
	};
}

export interface ToolRetrievalIndex {
	fingerprint: string;
	readonly descriptors: readonly ToolDescriptor[];
	estimatedBytes: number;
	mode: "inverted" | "linear";
	documentFrequency: ReadonlyMap<string, number>;
	readonly postings: ReadonlyMap<string, readonly number[]>;
}

interface TokenizedDescriptorFields {
	allPositive: string[];
	nameTitle: string[];
	aliasesExamples: string[];
	description: string[];
	parameters: string[];
	domain: string[];
	negativeExamples: string[];
}

class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
	readonly #values: Map<K, V>;

	constructor(entries: Iterable<readonly [K, V]>) {
		this.#values = new Map(entries);
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	get(key: K): V | undefined {
		return this.#values.get(key);
	}

	has(key: K): boolean {
		return this.#values.has(key);
	}

	forEach(
		callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
		thisArg?: unknown,
	): void {
		for (const [key, value] of this.#values) {
			callbackfn.call(thisArg, value, key, this);
		}
	}

	entries(): MapIterator<[K, V]> {
		return this.#values.entries();
	}

	keys(): MapIterator<K> {
		return this.#values.keys();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}
}

function freezeDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
	return Object.freeze({
		...descriptor,
		aliases: Object.freeze([...descriptor.aliases]),
		parameterNames: Object.freeze([...descriptor.parameterNames]),
		parameterDescriptions: Object.freeze([...descriptor.parameterDescriptions]),
		operations: Object.freeze([...descriptor.operations]),
		destinations: Object.freeze([...descriptor.destinations]),
		positiveExamples: Object.freeze([...descriptor.positiveExamples]),
		negativeExamples: Object.freeze([...descriptor.negativeExamples]),
	}) as ToolDescriptor;
}

function tokenizedFields(
	descriptor: ToolDescriptor,
): TokenizedDescriptorFields {
	const nameTitle = tokenizeToolText(
		[descriptor.indexedName, descriptor.title].filter(Boolean).join(" "),
	);
	const aliasesExamples = tokenizeToolText(
		[...descriptor.aliases, ...descriptor.positiveExamples].join(" "),
	);
	const description = tokenizeToolText(descriptor.description);
	const parameters = tokenizeToolText(
		[...descriptor.parameterNames, ...descriptor.parameterDescriptions].join(
			" ",
		),
	);
	const domain = tokenizeToolText(
		[descriptor.domain, ...descriptor.operations, ...descriptor.destinations]
			.filter(Boolean)
			.join(" "),
	);

	return {
		allPositive: [
			...new Set([
				...nameTitle,
				...aliasesExamples,
				...description,
				...parameters,
				...domain,
			]),
		],
		nameTitle,
		aliasesExamples,
		description,
		parameters,
		domain,
		negativeExamples: tokenizeToolText(descriptor.negativeExamples.join(" ")),
	};
}

function estimateIndexBytes(
	descriptors: readonly ToolDescriptor[],
	postings: ReadonlyMap<string, readonly number[]>,
): number {
	const serializedPayloadBytes = Buffer.byteLength(
		JSON.stringify({
			descriptors: descriptors.map(
				({ tool: _tool, ...retainedDescriptor }) => retainedDescriptor,
			),
			documentFrequency: [...postings].map(([token, ids]) => [
				token,
				ids.length,
			]),
			postings: [...postings],
		}),
		"utf8",
	);
	const mapEntryCount = postings.size * 2;
	const retainedArrayCount = descriptors.length * 7 + postings.size;

	return (
		serializedPayloadBytes * SERIALIZED_PAYLOAD_MULTIPLIER +
		mapEntryCount * MAP_ENTRY_OVERHEAD_BYTES +
		descriptors.length * DESCRIPTOR_OBJECT_OVERHEAD_BYTES +
		retainedArrayCount * ARRAY_OBJECT_OVERHEAD_BYTES
	);
}

export function buildToolRetrievalIndex(
	descriptors: ToolDescriptor[],
	options: { maxIndexBytes?: number } = {},
): ToolRetrievalIndex {
	const immutableDescriptors = Object.freeze(descriptors.map(freezeDescriptor));
	const mutablePostings = new Map<string, number[]>();

	immutableDescriptors.forEach((descriptor, documentId) => {
		for (const token of tokenizedFields(descriptor).allPositive) {
			const posting = mutablePostings.get(token) ?? [];
			posting.push(documentId);
			mutablePostings.set(token, posting);
		}
	});

	const postings = new Map<string, readonly number[]>();
	const documentFrequency = new Map<string, number>();
	for (const [token, documentIds] of mutablePostings) {
		const immutableIds = Object.freeze([...documentIds]);
		postings.set(token, immutableIds);
		documentFrequency.set(token, immutableIds.length);
	}

	const estimatedBytes = estimateIndexBytes(immutableDescriptors, postings);
	const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
	const mode = estimatedBytes > maxIndexBytes ? "linear" : "inverted";
	const immutableDocumentFrequency = new ImmutableReadonlyMap(
		documentFrequency,
	);
	const immutablePostings = new ImmutableReadonlyMap(
		mode === "inverted" ? postings : [],
	);

	return Object.freeze({
		fingerprint: inventoryFingerprint([...immutableDescriptors]),
		descriptors: immutableDescriptors,
		estimatedBytes,
		mode,
		documentFrequency: immutableDocumentFrequency,
		postings: immutablePostings,
	});
}

function idf(index: ToolRetrievalIndex, token: string): number {
	const documentCount = index.descriptors.length;
	const frequency = index.documentFrequency.get(token) ?? 0;
	return Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
}

function boundedTf(present: boolean): number {
	if (!present) return 0;
	const frequency = 1;
	return (frequency * 2.2) / (frequency + 1.2);
}

function weightedFieldScore(
	index: ToolRetrievalIndex,
	queryTokens: readonly string[],
	fieldTokens: readonly string[],
	weight: number,
): number {
	const field = new Set(fieldTokens);
	return queryTokens.reduce(
		(total, token) =>
			total + idf(index, token) * boundedTf(field.has(token)) * weight,
		0,
	);
}

function scoreDescriptor(
	index: ToolRetrievalIndex,
	descriptor: ToolDescriptor,
	normalizedQuery: string,
	queryTokens: readonly string[],
): ToolCandidateMatch {
	const fields = tokenizedFields(descriptor);
	const normalizedName = normalizeToolText(descriptor.indexedName);
	const normalizedKey = normalizeToolText(descriptor.indexedKey);
	const exactName =
		normalizedQuery === normalizedName || normalizedQuery === normalizedKey
			? 6
			: 0;
	const nameTitle = weightedFieldScore(index, queryTokens, fields.nameTitle, 4);
	const aliasesExamples = weightedFieldScore(
		index,
		queryTokens,
		fields.aliasesExamples,
		3,
	);
	const description = weightedFieldScore(
		index,
		queryTokens,
		fields.description,
		2,
	);
	const parameters = weightedFieldScore(
		index,
		queryTokens,
		fields.parameters,
		1.5,
	);
	const domain = weightedFieldScore(index, queryTokens, fields.domain, 0.5);
	const negativePenalty = Math.min(
		6,
		weightedFieldScore(index, queryTokens, fields.negativeExamples, 2),
	);
	const totalScore =
		exactName +
		nameTitle +
		aliasesExamples +
		description +
		parameters +
		domain -
		negativePenalty;

	return {
		descriptor,
		totalScore,
		scoreBreakdown: {
			exactName,
			nameTitle,
			aliasesExamples,
			description,
			parameters,
			domain,
			negativePenalty,
		},
	};
}

export function searchToolRetrievalIndex(
	index: ToolRetrievalIndex,
	query: string,
	limit: number,
	eligibleKeys?: ReadonlySet<string>,
): ToolCandidateMatch[] {
	const normalizedQuery = normalizeToolText(query);
	const queryTokens = tokenizeToolText(normalizedQuery);
	const boundedLimit = Math.max(0, Math.floor(limit));

	return index.descriptors
		.filter((descriptor) => !eligibleKeys || eligibleKeys.has(descriptor.key))
		.map((descriptor) =>
			scoreDescriptor(index, descriptor, normalizedQuery, queryTokens),
		)
		.sort((left, right) => {
			const scoreDelta = right.totalScore - left.totalScore;
			if (Math.abs(scoreDelta) > SCORE_TIE_EPSILON) return scoreDelta;

			const priorityDelta =
				TOOL_PRIORITY_WEIGHT[left.descriptor.priority] -
				TOOL_PRIORITY_WEIGHT[right.descriptor.priority];
			if (priorityDelta !== 0) return priorityDelta;

			const indexDelta =
				left.descriptor.originalIndex - right.descriptor.originalIndex;
			if (indexDelta !== 0) return indexDelta;

			return left.descriptor.key.localeCompare(right.descriptor.key);
		})
		.slice(0, boundedLimit);
}
