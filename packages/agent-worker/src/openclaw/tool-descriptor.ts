import { createHash } from "node:crypto";
import type { McpToolDef } from "@lobu/core";
import { catalogEntryForTool, type ToolPriority } from "./tool-catalog";
import type { ToolDestination, ToolOperation } from "./tool-route-query";

const MAX_INDEXED_TEXT_BYTES = 16 * 1024;
const DESCRIPTOR_VERSION = 1;

export interface ToolDescriptor {
	key: string;
	mcpId: string;
	name: string;
	title?: string;
	description: string;
	aliases: string[];
	parameterNames: string[];
	parameterDescriptions: string[];
	domain?: string;
	operations: ToolOperation[];
	destinations: ToolDestination[];
	positiveExamples: string[];
	negativeExamples: string[];
	readOnly: boolean;
	mutatesState: boolean;
	requiresConfirmation: boolean;
	priority: ToolPriority;
	originalIndex: number;
	indexedTextBytes: number;
	tool: McpToolDef;
}

interface DescriptorOverride {
	aliases: string[];
	operations: ToolOperation[];
	destinations: ToolDestination[];
	positiveExamples: string[];
	negativeExamples: string[];
	readOnly: boolean;
	mutatesState: boolean;
	requiresConfirmation: boolean;
}

const DESCRIPTOR_OVERRIDES: Readonly<Record<string, DescriptorOverride>> = {
	"lobu-memory/manage_schedules": {
		aliases: ["提醒我", "稍後叫我", "個人提醒", "延遲提醒", "agent schedule"],
		operations: ["create", "update", "delete", "schedule"],
		destinations: ["personal_reminder"],
		positiveExamples: ["五分鐘後提醒我", "明天提醒我繳費"],
		negativeExamples: ["Google Calendar", "行事曆"],
		readOnly: false,
		mutatesState: true,
		requiresConfirmation: true,
	},
	"google_workspace/gws_calendar_events_create": {
		aliases: ["Google Calendar", "建立行事曆事件", "建立日曆事件"],
		operations: ["create"],
		destinations: ["google_calendar"],
		positiveExamples: ["放進 Google Calendar", "建立行事曆會議"],
		negativeExamples: ["提醒我", "稍後叫我"],
		readOnly: false,
		mutatesState: true,
		requiresConfirmation: true,
	},
};

function sanitize(value: unknown): string {
	if (typeof value !== "string") return "";
	return [...value]
		.map((codepoint) => {
			const codepointValue = codepoint.codePointAt(0) ?? 0;
			return codepointValue <= 0x1f ||
				(codepointValue >= 0x7f && codepointValue <= 0x9f)
				? " "
				: codepoint;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map(sanitize).filter(Boolean))];
}

function searchableText(descriptor: ToolDescriptor): string {
	return [
		descriptor.key,
		descriptor.name,
		descriptor.title,
		descriptor.aliases.join(" "),
		descriptor.description,
		descriptor.parameterNames.join(" "),
		descriptor.parameterDescriptions.join(" "),
		descriptor.domain,
		descriptor.operations.join(" "),
		descriptor.destinations.join(" "),
		descriptor.positiveExamples.join(" "),
		descriptor.negativeExamples.join(" "),
	]
		.filter(Boolean)
		.join("\n");
}

function indexedBytes(descriptor: ToolDescriptor): number {
	return Buffer.byteLength(searchableText(descriptor), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

	let result = "";
	let bytes = 0;
	for (const codepoint of value) {
		const nextBytes = Buffer.byteLength(codepoint, "utf8");
		if (bytes + nextBytes > maxBytes) break;
		result += codepoint;
		bytes += nextBytes;
	}
	return result.trim();
}

function trimArrayToFit(descriptor: ToolDescriptor, values: string[]): void {
	while (
		values.length > 0 &&
		indexedBytes(descriptor) > MAX_INDEXED_TEXT_BYTES
	) {
		values.pop();
	}
}

function trimStringToFit(
	descriptor: ToolDescriptor,
	field: "title" | "description" | "domain",
): void {
	const value = descriptor[field];
	if (!value || indexedBytes(descriptor) <= MAX_INDEXED_TEXT_BYTES) return;

	const currentBytes = Buffer.byteLength(value, "utf8");
	const excess = indexedBytes(descriptor) - MAX_INDEXED_TEXT_BYTES;
	descriptor[field] = truncateUtf8(value, Math.max(0, currentBytes - excess));
}

function boundSearchableText(descriptor: ToolDescriptor): void {
	trimArrayToFit(descriptor, descriptor.parameterDescriptions);
	trimArrayToFit(descriptor, descriptor.positiveExamples);
	trimArrayToFit(descriptor, descriptor.negativeExamples);
	trimStringToFit(descriptor, "description");

	// These fields are normally tiny trusted metadata. Keep them searchable when
	// possible, but defensively bound malformed schemas without dropping identity.
	trimStringToFit(descriptor, "title");
	trimArrayToFit(descriptor, descriptor.aliases);
	trimArrayToFit(descriptor, descriptor.parameterNames);
	trimStringToFit(descriptor, "domain");
	trimArrayToFit(descriptor, descriptor.operations);
	trimArrayToFit(descriptor, descriptor.destinations);

	descriptor.indexedTextBytes = indexedBytes(descriptor);
}

function inferOperations(name: string): ToolOperation[] {
	const operations: ToolOperation[] = [];
	const normalized = name.toLowerCase();
	for (const operation of [
		"read",
		"search",
		"create",
		"update",
		"delete",
		"send",
		"schedule",
	] as const) {
		if (normalized.includes(operation)) operations.push(operation);
	}
	return operations.length > 0 ? operations : ["unknown"];
}

function parameterMetadata(tool: McpToolDef): {
	names: string[];
	descriptions: string[];
} {
	const properties = tool.inputSchema?.properties;
	if (
		!properties ||
		typeof properties !== "object" ||
		Array.isArray(properties)
	) {
		return { names: [], descriptions: [] };
	}

	const names: string[] = [];
	const descriptions: string[] = [];
	for (const [name, schema] of Object.entries(properties)) {
		const sanitizedName = sanitize(name);
		if (sanitizedName) names.push(sanitizedName);
		if (schema && typeof schema === "object" && !Array.isArray(schema)) {
			const description = sanitize(
				(schema as Record<string, unknown>).description,
			);
			if (description) descriptions.push(description);
		}
	}
	return {
		names: uniqueStrings(names),
		descriptions: uniqueStrings(descriptions),
	};
}

export function buildToolDescriptor(
	tool: McpToolDef,
	mcpId: string,
	originalIndex: number,
): ToolDescriptor {
	const entry = catalogEntryForTool(tool, originalIndex, mcpId);
	const name = sanitize(entry.name);
	const sanitizedMcpId = sanitize(mcpId);
	const key = sanitizedMcpId ? `${sanitizedMcpId}/${name}` : name;
	const override = DESCRIPTOR_OVERRIDES[key];
	const looseTool = tool as McpToolDef & { title?: unknown };
	const parameters = parameterMetadata(tool);
	const descriptor: ToolDescriptor = {
		key,
		mcpId: sanitizedMcpId,
		name,
		title: sanitize(looseTool.title) || undefined,
		description: sanitize(tool.description),
		aliases: uniqueStrings([...entry.aliases, ...(override?.aliases ?? [])]),
		parameterNames: parameters.names,
		parameterDescriptions: parameters.descriptions,
		domain: entry.domain === "unknown" ? undefined : entry.domain,
		operations: override?.operations ?? inferOperations(name),
		destinations: override?.destinations ?? [],
		positiveExamples: override?.positiveExamples ?? [],
		negativeExamples: override?.negativeExamples ?? [],
		readOnly: override?.readOnly ?? entry.readOnly,
		mutatesState: override?.mutatesState ?? entry.mutatesState,
		requiresConfirmation:
			override?.requiresConfirmation ?? entry.requiresConfirmation,
		priority: entry.priority,
		originalIndex,
		indexedTextBytes: 0,
		tool,
	};

	boundSearchableText(descriptor);
	return descriptor;
}

export function inventoryFingerprint(descriptors: ToolDescriptor[]): string {
	const inventory = [...descriptors]
		.sort(
			(left, right) =>
				left.key.localeCompare(right.key) ||
				left.originalIndex - right.originalIndex,
		)
		.map(
			({ tool: _tool, indexedTextBytes: _indexedTextBytes, ...descriptor }) =>
				descriptor,
		);
	return createHash("sha256")
		.update(JSON.stringify({ version: DESCRIPTOR_VERSION, inventory }))
		.digest("hex");
}
