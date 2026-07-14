import { TOOL_PRIORITY_WEIGHT } from "./tool-catalog";
import { inventoryFingerprint, type ToolDescriptor } from "./tool-descriptor";
import {
	clearToolRouterCacheNamespace,
	releaseToolRouterCacheEntry,
	retainToolRouterCacheEntry,
	touchToolRouterCacheEntry,
} from "./tool-router-memory-budget";
import { normalizeToolText, tokenizeToolText } from "./tool-tokenizer";

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const CACHE_NAMESPACE = "retrieval-index";
const TOOL_RETRIEVAL_INDEX_SCHEMA = "semantic-v1";
const MAX_QUERY_BYTES = 4 * 1024;
const MAX_QUERY_TOKENS = 128;
const SCORE_TIE_EPSILON = 1e-9;
// These are intentionally conservative accounting allowances, not claims about
// exact V8 heap layout. Serialized UTF-8 payload is doubled for string storage,
// then explicit collection/object overhead is added for retained structures.
const SERIALIZED_PAYLOAD_MULTIPLIER = 2;
const MAP_ENTRY_OVERHEAD_BYTES = 48;
const DESCRIPTOR_OBJECT_OVERHEAD_BYTES = 256;
const ARRAY_OBJECT_OVERHEAD_BYTES = 32;
const POSTING_DOCUMENT_BYTES = 16;

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
	readonly documentIdsByIdentity: ReadonlyMap<string, readonly number[]>;
}

export interface CachedToolRetrievalIndex {
	index: ToolRetrievalIndex;
	cacheHit: boolean;
	buildMs: number;
	cacheEvictionCount: number;
}

interface ToolRetrievalIndexCacheEntry {
	index: ToolRetrievalIndex;
	estimatedBytes: number;
}

const toolRetrievalIndexCache = new Map<string, ToolRetrievalIndexCacheEntry>();
let toolRetrievalIndexCacheBytes = 0;
let toolRetrievalIndexCacheEvictions = 0;
let toolRetrievalIndexCacheHits = 0;
let toolRetrievalIndexCacheMisses = 0;

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
		sideEffectClasses: Object.freeze([...descriptor.sideEffectClasses]),
		primarySideEffect: descriptor.primarySideEffect
			? Object.freeze({ ...descriptor.primarySideEffect })
			: null,
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

function estimateDescriptorBytes(descriptor: ToolDescriptor): number {
	return (
		Buffer.byteLength(JSON.stringify(descriptor), "utf8") *
			SERIALIZED_PAYLOAD_MULTIPLIER +
		DESCRIPTOR_OBJECT_OVERHEAD_BYTES +
		8 * ARRAY_OBJECT_OVERHEAD_BYTES
	);
}

function estimateNewPostingTokenBytes(token: string): number {
	return (
		Buffer.byteLength(token, "utf8") * SERIALIZED_PAYLOAD_MULTIPLIER * 2 +
		MAP_ENTRY_OVERHEAD_BYTES * 2 +
		ARRAY_OBJECT_OVERHEAD_BYTES +
		POSTING_DOCUMENT_BYTES
	);
}

function estimateNewIdentityBytes(identityKey: string): number {
	return (
		Buffer.byteLength(identityKey, "utf8") * SERIALIZED_PAYLOAD_MULTIPLIER +
		MAP_ENTRY_OVERHEAD_BYTES +
		ARRAY_OBJECT_OVERHEAD_BYTES +
		POSTING_DOCUMENT_BYTES
	);
}

export function buildToolRetrievalIndex(
	descriptors: ToolDescriptor[],
	options: { maxIndexBytes?: number } = {},
): ToolRetrievalIndex {
	const immutableDescriptors = Object.freeze(descriptors.map(freezeDescriptor));
	const fingerprint = inventoryFingerprint([...immutableDescriptors]);
	const maxIndexBytes = options.maxIndexBytes ?? MAX_INDEX_BYTES;
	let estimatedBytes = immutableDescriptors.reduce(
		(total, descriptor) => total + estimateDescriptorBytes(descriptor),
		0,
	);
	const emptyMap = new ImmutableReadonlyMap<string, never>([]);

	if (estimatedBytes > maxIndexBytes) {
		return Object.freeze({
			fingerprint,
			descriptors: immutableDescriptors,
			estimatedBytes,
			mode: "linear" as const,
			documentFrequency: emptyMap,
			postings: emptyMap,
			documentIdsByIdentity: emptyMap,
		});
	}

	const mutableDocumentIdsByIdentity = new Map<string, number[]>();
	for (
		let documentId = 0;
		documentId < immutableDescriptors.length;
		documentId++
	) {
		const descriptor = immutableDescriptors[documentId];
		if (!descriptor) continue;
		const documentIds = mutableDocumentIdsByIdentity.get(
			descriptor.identityKey,
		);
		if (documentIds) {
			documentIds.push(documentId);
			estimatedBytes += POSTING_DOCUMENT_BYTES;
		} else {
			mutableDocumentIdsByIdentity.set(descriptor.identityKey, [documentId]);
			estimatedBytes += estimateNewIdentityBytes(descriptor.identityKey);
		}
		if (estimatedBytes > maxIndexBytes) {
			mutableDocumentIdsByIdentity.clear();
			return Object.freeze({
				fingerprint,
				descriptors: immutableDescriptors,
				estimatedBytes,
				mode: "linear" as const,
				documentFrequency: emptyMap,
				postings: emptyMap,
				documentIdsByIdentity: emptyMap,
			});
		}
	}

	const mutablePostings = new Map<string, number[]>();
	for (
		let documentId = 0;
		documentId < immutableDescriptors.length;
		documentId++
	) {
		const descriptor = immutableDescriptors[documentId];
		if (!descriptor) continue;
		for (const token of tokenizedFields(descriptor).allPositive) {
			const posting = mutablePostings.get(token);
			if (posting) {
				posting.push(documentId);
				estimatedBytes += POSTING_DOCUMENT_BYTES;
			} else {
				mutablePostings.set(token, [documentId]);
				estimatedBytes += estimateNewPostingTokenBytes(token);
			}
		}

		if (estimatedBytes > maxIndexBytes) {
			mutablePostings.clear();
			mutableDocumentIdsByIdentity.clear();
			return Object.freeze({
				fingerprint,
				descriptors: immutableDescriptors,
				estimatedBytes,
				mode: "linear" as const,
				documentFrequency: emptyMap,
				postings: emptyMap,
				documentIdsByIdentity: emptyMap,
			});
		}
	}

	const postings = new Map<string, readonly number[]>();
	const documentFrequency = new Map<string, number>();
	for (const [token, documentIds] of mutablePostings) {
		const immutableIds = Object.freeze([...documentIds]);
		postings.set(token, immutableIds);
		documentFrequency.set(token, immutableIds.length);
	}

	const immutableDocumentFrequency = new ImmutableReadonlyMap(
		documentFrequency,
	);
	const immutablePostings = new ImmutableReadonlyMap(postings);
	const immutableDocumentIdsByIdentity = new ImmutableReadonlyMap(
		[...mutableDocumentIdsByIdentity].map(
			([identityKey, documentIds]) =>
				[identityKey, Object.freeze([...documentIds])] as const,
		),
	);

	return Object.freeze({
		fingerprint,
		descriptors: immutableDescriptors,
		estimatedBytes,
		mode: "inverted" as const,
		documentFrequency: immutableDocumentFrequency,
		postings: immutablePostings,
		documentIdsByIdentity: immutableDocumentIdsByIdentity,
	});
}

function retrievalIndexCacheKey(descriptors: ToolDescriptor[]): string {
	return `${TOOL_RETRIEVAL_INDEX_SCHEMA}:${inventoryFingerprint(descriptors)}`;
}

export function getOrBuildToolRetrievalIndex(
	descriptors: ToolDescriptor[],
): CachedToolRetrievalIndex {
	const startedAt = performance.now();
	const cacheKey = retrievalIndexCacheKey(descriptors);
	const cached = toolRetrievalIndexCache.get(cacheKey);
	if (cached) {
		toolRetrievalIndexCache.delete(cacheKey);
		toolRetrievalIndexCache.set(cacheKey, cached);
		touchToolRouterCacheEntry(CACHE_NAMESPACE, cacheKey);
		toolRetrievalIndexCacheHits++;
		return {
			index: cached.index,
			cacheHit: true,
			buildMs: performance.now() - startedAt,
			cacheEvictionCount: 0,
		};
	}
	toolRetrievalIndexCacheMisses++;

	const index = buildToolRetrievalIndex(descriptors, {
		maxIndexBytes: MAX_INDEX_BYTES,
	});
	let cacheEvictionCount = 0;
	if (index.estimatedBytes <= MAX_INDEX_BYTES) {
		const retained = retainToolRouterCacheEntry({
			namespace: CACHE_NAMESPACE,
			key: cacheKey,
			estimatedBytes: index.estimatedBytes,
			onEvict: () => {
				const evicted = toolRetrievalIndexCache.get(cacheKey);
				if (!evicted) return;
				toolRetrievalIndexCache.delete(cacheKey);
				toolRetrievalIndexCacheBytes -= evicted.estimatedBytes;
				cacheEvictionCount++;
				toolRetrievalIndexCacheEvictions++;
			},
		});
		cacheEvictionCount = retained.evictionCount;
		if (retained.retained) {
			toolRetrievalIndexCache.set(cacheKey, {
				index,
				estimatedBytes: index.estimatedBytes,
			});
			toolRetrievalIndexCacheBytes += index.estimatedBytes;
		}
	}

	return {
		index,
		cacheHit: false,
		buildMs: performance.now() - startedAt,
		cacheEvictionCount,
	};
}

export function toolRetrievalIndexCacheStats(): {
	entries: number;
	estimatedBytes: number;
	evictionCount: number;
	hits: number;
	misses: number;
} {
	return {
		entries: toolRetrievalIndexCache.size,
		estimatedBytes: toolRetrievalIndexCacheBytes,
		evictionCount: toolRetrievalIndexCacheEvictions,
		hits: toolRetrievalIndexCacheHits,
		misses: toolRetrievalIndexCacheMisses,
	};
}

export function clearToolRetrievalIndexCacheForTests(): void {
	for (const key of toolRetrievalIndexCache.keys()) {
		releaseToolRouterCacheEntry(CACHE_NAMESPACE, key);
	}
	clearToolRouterCacheNamespace(CACHE_NAMESPACE);
	toolRetrievalIndexCache.clear();
	toolRetrievalIndexCacheBytes = 0;
	toolRetrievalIndexCacheEvictions = 0;
	toolRetrievalIndexCacheHits = 0;
	toolRetrievalIndexCacheMisses = 0;
}

interface ScoringContext {
	documentCount: number;
	documentFrequency: ReadonlyMap<string, number>;
}

function idf(context: ScoringContext, token: string): number {
	const frequency = context.documentFrequency.get(token) ?? 0;
	return Math.log(
		1 + (context.documentCount - frequency + 0.5) / (frequency + 0.5),
	);
}

function boundedTf(present: boolean): number {
	if (!present) return 0;
	const frequency = 1;
	return (frequency * 2.2) / (frequency + 1.2);
}

function weightedFieldScore(
	context: ScoringContext,
	queryTokens: readonly string[],
	fieldTokens: readonly string[],
	weight: number,
): number {
	const field = new Set(fieldTokens);
	return queryTokens.reduce(
		(total, token) =>
			total + idf(context, token) * boundedTf(field.has(token)) * weight,
		0,
	);
}

function scoreDescriptor(
	context: ScoringContext,
	descriptor: ToolDescriptor,
	fields: TokenizedDescriptorFields,
	normalizedQuery: string,
	queryTokens: readonly string[],
): ToolCandidateMatch {
	const normalizedName = normalizeToolText(descriptor.indexedName);
	const normalizedKey = normalizeToolText(descriptor.indexedKey);
	const exactName =
		normalizedQuery === normalizedName || normalizedQuery === normalizedKey
			? 6
			: 0;
	const nameTitle = weightedFieldScore(
		context,
		queryTokens,
		fields.nameTitle,
		4,
	);
	const aliasesExamples = weightedFieldScore(
		context,
		queryTokens,
		fields.aliasesExamples,
		3,
	);
	const description = weightedFieldScore(
		context,
		queryTokens,
		fields.description,
		2,
	);
	const parameters = weightedFieldScore(
		context,
		queryTokens,
		fields.parameters,
		1.5,
	);
	const domain = weightedFieldScore(context, queryTokens, fields.domain, 0.5);
	const negativePenalty = Math.min(
		6,
		weightedFieldScore(context, queryTokens, fields.negativeExamples, 2),
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

function truncateUtf8(value: string, maxBytes: number): string {
	const result: string[] = [];
	let bytes = 0;
	for (const codepoint of value) {
		const codepointBytes = Buffer.byteLength(codepoint, "utf8");
		if (bytes + codepointBytes > maxBytes) break;
		result.push(codepoint);
		bytes += codepointBytes;
	}
	return result.join("");
}

function compareMatches(
	left: ToolCandidateMatch,
	right: ToolCandidateMatch,
): number {
	const scoreDelta = right.totalScore - left.totalScore;
	if (Math.abs(scoreDelta) > SCORE_TIE_EPSILON) return scoreDelta;
	const priorityDelta =
		TOOL_PRIORITY_WEIGHT[left.descriptor.priority] -
		TOOL_PRIORITY_WEIGHT[right.descriptor.priority];
	if (priorityDelta !== 0) return priorityDelta;
	const indexDelta =
		left.descriptor.originalIndex - right.descriptor.originalIndex;
	if (indexDelta !== 0) return indexDelta;
	return left.descriptor.identityKey.localeCompare(
		right.descriptor.identityKey,
	);
}

function searchInvertedIndex(
	index: ToolRetrievalIndex,
	normalizedQuery: string,
	queryTokens: readonly string[],
	eligibleKeys: ReadonlySet<string> | undefined,
): ToolCandidateMatch[] {
	const eligibleDocumentIds = eligibleKeys
		? new Set(
				[...eligibleKeys].flatMap(
					(identityKey) => index.documentIdsByIdentity.get(identityKey) ?? [],
				),
			)
		: null;
	const candidateDocumentIds = new Set<number>();
	const documentFrequency = new Map<string, number>();
	for (const token of queryTokens) {
		let frequency = 0;
		for (const documentId of index.postings.get(token) ?? []) {
			if (eligibleDocumentIds && !eligibleDocumentIds.has(documentId)) continue;
			candidateDocumentIds.add(documentId);
			frequency++;
		}
		documentFrequency.set(token, frequency);
	}
	const context: ScoringContext = {
		documentCount: eligibleDocumentIds?.size ?? index.descriptors.length,
		documentFrequency,
	};
	return [...candidateDocumentIds].flatMap((documentId) => {
		const descriptor = index.descriptors[documentId];
		return descriptor
			? [
					scoreDescriptor(
						context,
						descriptor,
						tokenizedFields(descriptor),
						normalizedQuery,
						queryTokens,
					),
				]
			: [];
	});
}

function searchLinearIndex(
	index: ToolRetrievalIndex,
	normalizedQuery: string,
	queryTokens: readonly string[],
	eligibleKeys: ReadonlySet<string> | undefined,
): ToolCandidateMatch[] {
	const eligible = index.descriptors
		.filter(
			(descriptor) => !eligibleKeys || eligibleKeys.has(descriptor.identityKey),
		)
		.map((descriptor) => ({ descriptor, fields: tokenizedFields(descriptor) }));
	const documentFrequency = new Map<string, number>();
	for (const token of queryTokens) {
		documentFrequency.set(
			token,
			eligible.reduce(
				(frequency, { fields }) =>
					frequency + (fields.allPositive.includes(token) ? 1 : 0),
				0,
			),
		);
	}
	const context: ScoringContext = {
		documentCount: eligible.length,
		documentFrequency,
	};
	return eligible.map(({ descriptor, fields }) =>
		scoreDescriptor(context, descriptor, fields, normalizedQuery, queryTokens),
	);
}

export function searchToolRetrievalIndex(
	index: ToolRetrievalIndex,
	query: string,
	limit: number,
	eligibleKeys?: ReadonlySet<string>,
): ToolCandidateMatch[] {
	const normalizedQuery = normalizeToolText(
		truncateUtf8(query, MAX_QUERY_BYTES),
	);
	const queryTokens = tokenizeToolText(normalizedQuery).slice(
		0,
		MAX_QUERY_TOKENS,
	);
	const boundedLimit = Math.max(0, Math.floor(limit));
	if (boundedLimit === 0 || queryTokens.length === 0) return [];
	const matches =
		index.mode === "inverted"
			? searchInvertedIndex(index, normalizedQuery, queryTokens, eligibleKeys)
			: searchLinearIndex(index, normalizedQuery, queryTokens, eligibleKeys);
	return matches
		.filter((match) => match.totalScore > 0)
		.sort(compareMatches)
		.slice(0, boundedLimit);
}
