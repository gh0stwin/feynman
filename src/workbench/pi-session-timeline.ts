import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
	SessionManager,
	parseSessionEntries,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import type { WorkbenchPiSessionStatus } from "./pi-session.js";
import { workbenchPiSessionId } from "./pi-session.js";

/**
 * Read-only chronological view of a workbench session's pi session record.
 *
 * The pi session JSONL is the durable, append-only record of everything the
 * agent did (thoughts, tool calls, answers) in tree form. This module parses
 * it with pi's own parser, builds the current branch with pi's own
 * SessionManager (in-memory, never persisting), and exposes the branch as a
 * typed, paginated entry stream.
 *
 * Hard rules:
 * - READ-ONLY: session files are opened for reading exactly once; they are
 *   never written, moved, or truncated. A partial final line (mid-turn tail)
 *   is ignored via pi's parser instead of being repaired.
 * - Large sessions never serialize wholesale: content is bounded per field
 *   and pages are bounded by entry count and total content budget.
 * - Missing or not-yet-flushed session files return a clean not-ready shape
 *   ("missing" / "pending"), never a thrown error.
 */

export type WorkbenchPiTimelineKind =
	| "thinking"
	| "message"
	| "tool_result"
	| "custom"
	| "custom_message"
	| "compaction"
	| "branch_summary"
	| "session_info"
	| "model_change"
	| "thinking_level_change"
	| "bash_execution"
	| "label"
	| "other";

export type WorkbenchPiTimelineBlock = {
	type: string;
	contentIndex: number;
	text?: string;
	truncated?: boolean;
	fullLength?: number;
	toolCallId?: string;
	toolName?: string;
	arguments?: string;
	argumentsTruncated?: boolean;
	mimeType?: string;
	sizeBytes?: number;
	dataOmitted?: true;
};

export type WorkbenchPiTimelineUsage = {
	input: number;
	output: number;
	totalTokens: number;
	costTotal: number;
};

export type WorkbenchPiTimelineEntry = {
	id: string;
	kind: WorkbenchPiTimelineKind;
	seq: number;
	timestamp?: string;
	parentId?: string;
	sourceId?: string;
	contentIndex?: number;
	entryType?: string;
	role?: string;
	text?: string;
	blocks?: WorkbenchPiTimelineBlock[];
	toolCallId?: string;
	toolName?: string;
	assistantId?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	customType?: string;
	display?: boolean;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	fromId?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	model?: string;
	thinkingLevel?: string;
	targetId?: string;
	label?: string;
	stopReason?: string;
	error?: string;
	usage?: WorkbenchPiTimelineUsage;
	truncated?: boolean;
	fullLength?: number;
	redacted?: boolean;
	details?: unknown;
	detailsTruncated?: boolean;
	detailsText?: string;
};

/** Timeline entry before its position in the chronological stream is assigned. */
type WorkbenchPiTimelineEntryBase = Omit<WorkbenchPiTimelineEntry, "seq">;

export type WorkbenchPiTimelineSessionRef = {
	id: string;
	workbenchSessionId: string;
	status: WorkbenchPiSessionStatus;
	path?: string;
	fileName?: string;
	cwd?: string;
	createdAt?: string;
	updatedAt?: string;
	leafId?: string;
	name?: string;
};

export type WorkbenchPiTimelinePagination = {
	total: number;
	count: number;
	firstSeq?: number;
	lastSeq?: number;
	hasOlder: boolean;
	olderCursor?: string;
	hasNewer: boolean;
	newerCursor?: string;
};

export type WorkbenchPiSessionTimeline = {
	status: WorkbenchPiSessionStatus;
	session: WorkbenchPiTimelineSessionRef;
	entries: WorkbenchPiTimelineEntry[];
	pagination: WorkbenchPiTimelinePagination;
};

export type WorkbenchPiTimelineOptions = {
	workingDir: string;
	sessionDir?: string;
	workbenchSessionId: string;
	piSessionId?: string;
	before?: string;
	after?: string;
	entry?: string;
	limit?: number;
	maxContentChars?: number;
	maxPageChars?: number;
};

export const DEFAULT_TIMELINE_LIMIT = 40;
export const MAX_TIMELINE_LIMIT = 200;
export const DEFAULT_MAX_CONTENT_CHARS = 12_000;
export const MAX_MAX_CONTENT_CHARS = 60_000;
export const DEFAULT_MAX_PAGE_CHARS = 200_000;
export const MAX_MAX_PAGE_CHARS = 1_000_000;
const MIN_MAX_CONTENT_CHARS = 200;
const MIN_MAX_PAGE_CHARS = 1_000;

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function clampCount(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function boundText(value: string, max: number): { text: string; truncated?: boolean; fullLength?: number } {
	if (value.length <= max) return { text: value };
	return { text: value.slice(0, max), truncated: true, fullLength: value.length };
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function entryTimestamp(value: unknown, fallbackMs: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof fallbackMs === "number" && Number.isFinite(fallbackMs)) return new Date(fallbackMs).toISOString();
	return undefined;
}

function usageOf(value: unknown): WorkbenchPiTimelineUsage | undefined {
	const record = unknownRecord(value);
	if (!record) return undefined;
	const cost = unknownRecord(record.cost);
	const number = (input: unknown): number => typeof input === "number" && Number.isFinite(input) ? input : 0;
	return {
		input: number(record.input),
		output: number(record.output),
		totalTokens: number(record.totalTokens),
		costTotal: number(cost?.total),
	};
}

function blockPayload(block: Record<string, unknown>, max: number, fallbackIndex = 0): WorkbenchPiTimelineBlock {
	const type = typeof block.type === "string" ? block.type : "unknown";
	// The block index is its position in the message content array; the pi
	// session JSONL stores content blocks without an index field, so the array
	// position is the fallback and the image endpoint addresses blocks by it.
	const contentIndex = typeof block.contentIndex === "number"
		? block.contentIndex
		: typeof block.index === "number"
			? block.index
			: fallbackIndex;
	const payload: WorkbenchPiTimelineBlock = { type, contentIndex };
	const textSource = typeof block.text === "string" ? block.text : typeof block.thinking === "string" ? block.thinking : undefined;
	if (textSource !== undefined) {
		const bounded = boundText(textSource, max);
		payload.text = bounded.text;
		if (bounded.truncated) {
			payload.truncated = true;
			payload.fullLength = bounded.fullLength;
		}
	}
	if (type === "toolCall" && typeof block.id === "string") {
		payload.toolCallId = block.id;
		if (typeof block.name === "string") payload.toolName = block.name;
		if (block.arguments !== undefined) {
			const bounded = boundText(JSON.stringify(block.arguments) ?? "", max);
			payload.arguments = bounded.text;
			if (bounded.truncated) {
				payload.argumentsTruncated = true;
				payload.fullLength = bounded.fullLength;
			}
		}
	}
	if (type === "image") {
		// Base64 image payloads are never inlined in the timeline; metadata only.
		payload.dataOmitted = true;
		if (typeof block.mimeType === "string") payload.mimeType = block.mimeType;
		if (typeof block.data === "string") payload.sizeBytes = block.data.length;
	}
	return payload;
}

function entryContentChars(entry: WorkbenchPiTimelineEntry): number {
	let total = (entry.text?.length ?? 0)
		+ (entry.summary?.length ?? 0)
		+ (entry.output?.length ?? 0)
		+ (entry.detailsText?.length ?? 0);
	for (const block of entry.blocks ?? []) {
		total += (block.text?.length ?? 0) + (block.arguments?.length ?? 0);
	}
	return total;
}

function entryMessage(entry: SessionEntry): Record<string, unknown> | undefined {
	if (entry.type !== "message") return undefined;
	return unknownRecord((entry as unknown as { message: unknown }).message);
}

function messageContentBlocks(content: unknown, max: number): WorkbenchPiTimelineBlock[] {
	if (typeof content === "string") {
		const bounded = boundText(content, max);
		return [{
			type: "text",
			contentIndex: 0,
			text: bounded.text,
			...(bounded.truncated ? { truncated: true, fullLength: bounded.fullLength } : {}),
		}];
	}
	if (!Array.isArray(content)) return [];
	return content.flatMap((item, index) => {
		const record = unknownRecord(item);
		if (!record) return [];
		return [blockPayload(record, max, index)];
	});
}

function primaryText(content: unknown, max: number): { text?: string; truncated?: boolean; fullLength?: number } {
	if (typeof content === "string") return boundText(content, max);
	if (!Array.isArray(content)) return {};
	const parts = content
		.flatMap((item) => {
			const record = unknownRecord(item);
			if (!record) return [];
			if (record.type === "text" && typeof record.text === "string") return [record.text];
			return [];
		})
		.join("\n\n");
	return parts ? boundText(parts, max) : {};
}

function boundDetails(value: unknown, max: number): Pick<WorkbenchPiTimelineEntry, "details" | "detailsTruncated" | "detailsText"> {
	if (value === undefined || value === null) return {};
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return {};
		if (serialized.length <= max) return { details: value };
		const bounded = boundText(serialized, max);
		return { detailsTruncated: true, detailsText: bounded.text };
	} catch {
		return { detailsTruncated: true };
	}
}

type AssistantToolCallIndex = Map<string, string>;

function buildAssistantToolCallIndex(branch: SessionEntry[]): AssistantToolCallIndex {
	const index: AssistantToolCallIndex = new Map();
	for (const entry of branch) {
		const message = entryMessage(entry);
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const record = unknownRecord(block);
			if (record?.type === "toolCall" && typeof record.id === "string") {
				index.set(record.id, entry.id);
			}
		}
	}
	return index;
}

type TimelineBase = Pick<WorkbenchPiTimelineEntryBase, "id" | "parentId" | "timestamp">;

function messageTimelineEntries(
	entry: SessionEntry,
	max: number,
	assistantByToolCallId: AssistantToolCallIndex,
	base: TimelineBase,
): WorkbenchPiTimelineEntryBase[] {
	const message = entryMessage(entry);
	if (!message) return [{ ...base, kind: "other", entryType: entry.type }];
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (role === "assistant") return assistantTimelineEntries(entry, message, max, base);
	if (role === "toolResult") return [toolResultTimelineEntry(message, max, assistantByToolCallId, base)];
	if (role === "bashExecution") {
		return [{
			...base,
			kind: "bash_execution",
			role,
			command: boundText(String(message.command ?? ""), max).text,
			output: boundText(String(message.output ?? ""), max).text,
			exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined,
			cancelled: message.cancelled === true,
		}];
	}
	if (role === "compactionSummary") {
		return [{ ...base, kind: "compaction", summary: boundText(String(message.summary ?? ""), max).text }];
	}
	if (role === "branchSummary") {
		return [{
			...base,
			kind: "branch_summary",
			fromId: typeof message.fromId === "string" ? message.fromId : undefined,
			summary: boundText(String(message.summary ?? ""), max).text,
		}];
	}
	if (role === "custom") {
		const primary = primaryText(message.content, max);
		return [{
			...base,
			kind: "custom_message",
			role,
			customType: typeof message.customType === "string" ? message.customType : undefined,
			display: message.display === true,
			...(primary.text ? { text: primary.text } : {}),
			...(primary.truncated ? { truncated: true, fullLength: primary.fullLength } : {}),
			blocks: messageContentBlocks(message.content, max),
			...boundDetails(message.details, max),
		}];
	}
	const primary = primaryText(message.content, max);
	return [{
		...base,
		kind: "message",
		role,
		...(primary.text ? { text: primary.text } : {}),
		...(primary.truncated ? { truncated: true, fullLength: primary.fullLength } : {}),
		blocks: messageContentBlocks(message.content, max),
	}];
}

function assistantTimelineEntries(
	entry: SessionEntry,
	message: Record<string, unknown>,
	max: number,
	base: TimelineBase,
): WorkbenchPiTimelineEntryBase[] {
	const content = Array.isArray(message.content) ? message.content : [];
	const entries: WorkbenchPiTimelineEntryBase[] = [];
	const blocks: WorkbenchPiTimelineBlock[] = [];
	content.forEach((item, index) => {
		const record = unknownRecord(item);
		if (!record) return;
		if (record.type === "thinking") {
			// Thinking blocks become their own timeline entries so the browser
			// can render the agent's reasoning separately from the reply.
			const bounded = boundText(typeof record.thinking === "string" ? record.thinking : "", max);
			entries.push({
				...base,
				id: `${entry.id}#thinking${index}`,
				kind: "thinking",
				sourceId: entry.id,
				contentIndex: index,
				text: bounded.text,
				...(bounded.truncated ? { truncated: true, fullLength: bounded.fullLength } : {}),
				...(record.redacted === true ? { redacted: true } : {}),
			});
			return;
		}
		blocks.push(blockPayload(record, max, index));
	});
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	const usage = usageOf(message.usage);
	const primary = primaryText(content, max);
	entries.push({
		...base,
		kind: "message",
		role: "assistant",
		...(primary.text ? { text: primary.text } : {}),
		...(primary.truncated ? { truncated: true, fullLength: primary.fullLength } : {}),
		blocks,
		model: [message.provider, message.model]
			.filter((part) => typeof part === "string" && part)
			.join("/") || undefined,
		...(stopReason ? { stopReason } : {}),
		...(stopReason === "error" || stopReason === "aborted"
			? { error: typeof message.errorMessage === "string" ? message.errorMessage : stopReason }
			: {}),
		...(usage ? { usage } : {}),
	});
	return entries;
}

function toolResultTimelineEntry(
	message: Record<string, unknown>,
	max: number,
	assistantByToolCallId: AssistantToolCallIndex,
	base: TimelineBase,
): WorkbenchPiTimelineEntryBase {
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
	const assistantId = toolCallId ? assistantByToolCallId.get(toolCallId) : undefined;
	const primary = primaryText(message.content, max);
	return {
		...base,
		kind: "tool_result",
		role: "toolResult",
		...(toolCallId ? { toolCallId } : {}),
		toolName: typeof message.toolName === "string" ? message.toolName : undefined,
		...(assistantId ? { assistantId } : {}),
		...(primary.text ? { text: primary.text } : {}),
		...(primary.truncated ? { truncated: true, fullLength: primary.fullLength } : {}),
		blocks: messageContentBlocks(message.content, max),
		isError: message.isError === true,
		...(usageOf(message.usage) ? { usage: usageOf(message.usage) } : {}),
		...boundDetails(message.details, max),
	};
}

function timelineEntriesForPiEntry(
	entry: SessionEntry,
	max: number,
	assistantByToolCallId: AssistantToolCallIndex,
): WorkbenchPiTimelineEntryBase[] {
	const message = entryMessage(entry);
	const base: TimelineBase = {
		id: entry.id,
		parentId: entry.parentId ?? undefined,
		timestamp: entryTimestamp(entry.timestamp, message?.timestamp),
	};
	if (entry.type === "message") return messageTimelineEntries(entry, max, assistantByToolCallId, base);
	if (entry.type === "compaction") {
		return [{
			...base,
			kind: "compaction",
			summary: boundText(String(entry.summary ?? ""), max).text,
			firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
			tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
		}];
	}
	if (entry.type === "branch_summary") {
		return [{
			...base,
			kind: "branch_summary",
			fromId: typeof entry.fromId === "string" ? entry.fromId : undefined,
			summary: boundText(String(entry.summary ?? ""), max).text,
		}];
	}
	if (entry.type === "custom") {
		return [{
			...base,
			kind: "custom",
			customType: typeof entry.customType === "string" ? entry.customType : undefined,
			...boundDetails(entry.data, max),
		}];
	}
	if (entry.type === "custom_message") {
		const primary = primaryText(entry.content, max);
		return [{
			...base,
			kind: "custom_message",
			customType: typeof entry.customType === "string" ? entry.customType : undefined,
			display: entry.display === true,
			...(primary.text ? { text: primary.text } : {}),
			...(primary.truncated ? { truncated: true, fullLength: primary.fullLength } : {}),
			blocks: messageContentBlocks(entry.content, max),
			...boundDetails(entry.details, max),
		}];
	}
	if (entry.type === "session_info") {
		return [{ ...base, kind: "session_info", name: typeof entry.name === "string" ? entry.name : undefined }];
	}
	if (entry.type === "model_change") {
		return [{ ...base, kind: "model_change", provider: entry.provider, modelId: entry.modelId }];
	}
	if (entry.type === "thinking_level_change") {
		return [{ ...base, kind: "thinking_level_change", thinkingLevel: entry.thinkingLevel }];
	}
	if (entry.type === "label") {
		return [{ ...base, kind: "label", targetId: entry.targetId, label: typeof entry.label === "string" ? entry.label : undefined }];
	}
	// Defensive: entries with a type pi's typings do not know yet still appear
	// (JSONL lines are arbitrary JSON at runtime).
	const unknownType = (entry as { type?: unknown }).type;
	return [{ ...base, kind: "other", entryType: typeof unknownType === "string" ? unknownType : "unknown" }];
}

export function buildWorkbenchPiTimelineEntries(
	branch: SessionEntry[],
	maxContentChars: number = DEFAULT_MAX_CONTENT_CHARS,
): WorkbenchPiTimelineEntry[] {
	const assistantByToolCallId = buildAssistantToolCallIndex(branch);
	const entries: WorkbenchPiTimelineEntryBase[] = [];
	for (const entry of branch) {
		entries.push(...timelineEntriesForPiEntry(entry, maxContentChars, assistantByToolCallId));
	}
	return entries.map((entry, seq) => ({ ...entry, seq }));
}

/**
 * Rebuild one timeline entry (including derived entries such as
 * "<entryId>#thinking0") at full fidelity, without content caps. Used by the
 * single-entry fetch so the browser can expand a bounded preview.
 */
export function buildFullWorkbenchPiTimelineEntry(
	branch: SessionEntry[],
	entryId: string,
): WorkbenchPiTimelineEntry | undefined {
	const piEntryId = entryId.split("#")[0] ?? entryId;
	const sourceEntry = branch.find((entry) => entry.id === piEntryId);
	if (!sourceEntry) return undefined;
	const entries = timelineEntriesForPiEntry(sourceEntry, Number.MAX_SAFE_INTEGER, buildAssistantToolCallIndex(branch));
	const entry = entries.find((candidate) => candidate.id === entryId);
	return entry ? { ...entry, seq: 0 } : undefined;
}

export type WorkbenchPiTimelinePageParams = {
	before?: string;
	after?: string;
	entry?: string;
	limit?: number;
	maxPageChars?: number;
};

export type WorkbenchPiTimelinePage = {
	entries: WorkbenchPiTimelineEntry[];
	pagination: WorkbenchPiTimelinePagination;
};

function pageForSlice(entries: WorkbenchPiTimelineEntry[], start: number, end: number): WorkbenchPiTimelinePagination {
	const total = entries.length;
	const page = entries.slice(start, end);
	const hasOlder = start > 0;
	const hasNewer = end < total;
	return {
		total,
		count: page.length,
		...(page.length ? { firstSeq: page[0]!.seq, lastSeq: page[page.length - 1]!.seq } : {}),
		hasOlder,
		// Empty pages (cursor at the stream edge) still expose the resume id.
		...(hasOlder && start < total ? { olderCursor: (page[0] ?? entries[start])!.id } : {}),
		hasNewer,
		...(hasNewer ? { newerCursor: (page[page.length - 1] ?? entries[end])!.id } : {}),
	};
}

function emptyPagination(total: number): WorkbenchPiTimelinePagination {
	return { total, count: 0, hasOlder: false, hasNewer: false };
}

/**
 * Walk backward from the cursor, packing entries until the page budget or
 * limit is hit. The entry immediately under the cursor is always included so
 * pagination always makes progress, even for a single oversized entry.
 */
function packBackward(entries: WorkbenchPiTimelineEntry[], endExclusive: number, limit: number, maxPageChars: number): number {
	let budget = maxPageChars;
	let start = endExclusive;
	while (start > 0 && endExclusive - start < limit) {
		const chars = entryContentChars(entries[start - 1]!);
		if (start < endExclusive && budget - chars < 0) break;
		budget -= chars;
		start--;
	}
	return start;
}

function packForward(entries: WorkbenchPiTimelineEntry[], startInclusive: number, limit: number, maxPageChars: number): number {
	let budget = maxPageChars;
	let end = startInclusive;
	while (end < entries.length && end - startInclusive < limit) {
		const chars = entryContentChars(entries[end]!);
		if (end > startInclusive && budget - chars < 0) break;
		budget -= chars;
		end++;
	}
	return end;
}

export function paginateTimelinePage(
	entries: WorkbenchPiTimelineEntry[],
	params: WorkbenchPiTimelinePageParams = {},
): WorkbenchPiTimelinePage {
	const limit = clampCount(params.limit, DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
	const maxPageChars = clampCount(params.maxPageChars, DEFAULT_MAX_PAGE_CHARS, MIN_MAX_PAGE_CHARS, MAX_MAX_PAGE_CHARS);
	const total = entries.length;
	if (params.entry !== undefined) {
		const index = entries.findIndex((candidate) => candidate.id === params.entry);
		if (index === -1) return { entries: [], pagination: emptyPagination(total) };
		const entry = entries[index]!;
		return {
			entries: [entry],
			pagination: {
				total,
				count: 1,
				firstSeq: entry.seq,
				lastSeq: entry.seq,
				hasOlder: index > 0,
				...(index > 0 ? { olderCursor: entries[index - 1]!.id } : {}),
				hasNewer: index < total - 1,
				...(index < total - 1 ? { newerCursor: entries[index + 1]!.id } : {}),
			},
		};
	}
	if (params.before !== undefined) {
		const index = entries.findIndex((candidate) => candidate.id === params.before);
		if (index === -1) return { entries: [], pagination: emptyPagination(total) };
		const start = packBackward(entries, index, limit, maxPageChars);
		return { entries: entries.slice(start, index), pagination: pageForSlice(entries, start, index) };
	}
	if (params.after !== undefined) {
		const index = entries.findIndex((candidate) => candidate.id === params.after);
		if (index === -1) return { entries: [], pagination: emptyPagination(total) };
		const end = packForward(entries, index + 1, limit, maxPageChars);
		return { entries: entries.slice(index + 1, end), pagination: pageForSlice(entries, index + 1, end) };
	}
	const start = packBackward(entries, total, limit, maxPageChars);
	return { entries: entries.slice(start, total), pagination: pageForSlice(entries, start, total) };
}

function notReadyTimeline(
	status: WorkbenchPiSessionStatus,
	session: WorkbenchPiTimelineSessionRef,
): WorkbenchPiSessionTimeline {
	return { status, session, entries: [], pagination: emptyPagination(0) };
}

const PI_SESSION_FILE_SUFFIX = ".jsonl";
const PI_SESSION_TIMELINE_PATHNAME = /^\/api\/chat\/session\/([^/]+)\/timeline$/;

/** Extract the workbench session id from a timeline endpoint pathname, if any. */
export function matchWorkbenchPiTimelineSessionId(pathname: string): string | undefined {
	const id = PI_SESSION_TIMELINE_PATHNAME.exec(pathname)?.[1];
	if (id === undefined) return undefined;
	try {
		return decodeURIComponent(id);
	} catch {
		// Malformed escape: keep the raw segment; it resolves to the not-ready shape.
		return id;
	}
}

/**
 * Serve GET /api/chat/session/:id/timeline. Returns false when the request is
 * not for the timeline endpoint so the caller can fall through to other routes.
 */
export async function handleWorkbenchPiTimelineRequest(
	options: Pick<WorkbenchPiTimelineOptions, "workingDir" | "sessionDir">,
	method: string | undefined,
	url: URL,
	send: (body: WorkbenchPiSessionTimeline) => void,
): Promise<boolean> {
	if (method !== "GET") return false;
	const workbenchSessionId = matchWorkbenchPiTimelineSessionId(url.pathname);
	if (!workbenchSessionId) return false;
	send(await readWorkbenchPiSessionTimeline({
		...options,
		workbenchSessionId,
		...workbenchPiTimelineQueryParams(url),
	}));
	return true;
}

/** Parse the pagination/cap query parameters of the timeline endpoint. */
export function workbenchPiTimelineQueryParams(url: URL): Pick<
	WorkbenchPiTimelineOptions,
	"before" | "after" | "entry" | "limit" | "maxContentChars" | "maxPageChars"
> {
	const stringParam = (key: string): string | undefined => {
		const value = url.searchParams.get(key);
		return typeof value === "string" && value.trim() ? value : undefined;
	};
	const numberParam = (key: string): number | undefined => {
		const value = url.searchParams.get(key);
		if (value === null || !value.trim()) return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	return {
		before: stringParam("before"),
		after: stringParam("after"),
		entry: stringParam("entry"),
		limit: numberParam("limit"),
		maxContentChars: numberParam("maxContentChars"),
		maxPageChars: numberParam("maxPageChars"),
	};
}

export type WorkbenchPiSessionImage = {
	bytes: Buffer;
	mimeType: string;
};

export type WorkbenchPiSessionImageResult =
	| { status: "found"; image: WorkbenchPiSessionImage }
	| { status: "missing" | "pending" | "not-found" };

const SAFE_MIME_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * Keep the recorded mimeType when it is a plain media type token; fall back to
 * a safe opaque type instead of echoing arbitrary strings into a header.
 */
function safeImageMimeType(value: unknown): string {
	return typeof value === "string" && SAFE_MIME_TYPE_PATTERN.test(value) ? value : "application/octet-stream";
}

/** Parse the ?block= query parameter of the image endpoint: a non-negative integer. */
export function parseWorkbenchImageBlockParam(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined || !/^(0|[1-9][0-9]*)$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const PI_SESSION_IMAGE_PATHNAME = /^\/api\/chat\/session\/([^/]+)\/entry\/([^/]+)\/image$/;

export type WorkbenchPiSessionImageRequestMatch = {
	workbenchSessionId: string;
	entryId: string;
};

/** Extract the session and entry ids from an image endpoint pathname, if any. */
export function matchWorkbenchPiImageRequest(pathname: string): WorkbenchPiSessionImageRequestMatch | undefined {
	const match = PI_SESSION_IMAGE_PATHNAME.exec(pathname);
	if (!match) return undefined;
	const decode = (raw: string): string => {
		try {
			return decodeURIComponent(raw);
		} catch {
			// Malformed escape: keep the raw segment; it fails entry resolution.
			return raw;
		}
	};
	return { workbenchSessionId: match[1]!, entryId: decode(match[2]!) };
}

/**
 * Resolve one base64 ImageContent block from a pi session record, read-only.
 * Images live inline in message content (user, assistant, or toolResult); the
 * addressed block is `message.content[blockIndex]`. Missing or not-yet-flushed
 * session files return clean "missing" / "pending" statuses; an unknown entry
 * or a block that is not an image returns "not-found" — never a thrown error
 * and never a write to the session file.
 */
export async function readWorkbenchPiSessionEntryImage(
	options: Pick<WorkbenchPiTimelineOptions, "workingDir" | "sessionDir">,
	workbenchSessionId: string,
	entryId: string,
	blockIndex: number,
): Promise<WorkbenchPiSessionImageResult> {
	if (!options.sessionDir) return { status: "pending" };
	const piSessionId = workbenchPiSessionId(workbenchSessionId);

	let sessionPath: string | undefined;
	try {
		sessionPath = await resolvePiSessionPath(options.sessionDir, options.workingDir, piSessionId);
	} catch {
		sessionPath = undefined;
	}
	if (!sessionPath) return { status: "missing" };

	let fileEntries: FileEntry[];
	let header: SessionHeader | null;
	try {
		({ fileEntries, header } = readTimelineFileEntries(sessionPath));
	} catch {
		// Unreadable or vanished between listing and read: clean not-ready shape.
		return { status: "missing" };
	}
	if (!header) return { status: "pending" };

	let branch: SessionEntry[];
	try {
		const manager = SessionManager.inMemory(header.cwd || options.workingDir, { id: header.id }, fileEntries);
		branch = manager.getBranch();
	} catch {
		// Corrupt-but-headered file: degrade to the not-ready shape.
		return { status: "pending" };
	}

	// Derived ids ("<entryId>#thinking0") address the same source entry.
	const piEntryId = entryId.split("#")[0] ?? entryId;
	const sourceEntry = branch.find((entry) => entry.id === piEntryId);
	if (!sourceEntry) return { status: "not-found" };
	const message = entryMessage(sourceEntry);
	if (!message) return { status: "not-found" };
	const content = message.content;
	if (typeof content === "string" || !Array.isArray(content)) return { status: "not-found" };
	const block = unknownRecord(content[blockIndex]);
	if (block?.type !== "image" || typeof block.data !== "string" || !block.data.length) {
		return { status: "not-found" };
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(block.data, "base64");
	} catch {
		return { status: "not-found" };
	}
	if (!bytes.length) return { status: "not-found" };
	return { status: "found", image: { bytes, mimeType: safeImageMimeType(block.mimeType) } };
}

/**
 * Serve GET /api/chat/session/:id/entry/:entryId/image?block=N. Returns false
 * when the request is not for the image endpoint so the caller can fall through
 * to other routes. On a match it always answers via sendImage/sendError — the
 * HTTP-level error behavior mirrors the timeline endpoint (clean, never a 500).
 */
export async function handleWorkbenchPiSessionImageRequest(
	options: Pick<WorkbenchPiTimelineOptions, "workingDir" | "sessionDir">,
	method: string | undefined,
	url: URL,
	sendImage: (image: WorkbenchPiSessionImage) => void,
	sendError: (status: number, message: string) => void,
): Promise<boolean> {
	if (method !== "GET") return false;
	const match = matchWorkbenchPiImageRequest(url.pathname);
	if (!match) return false;
	const blockIndex = parseWorkbenchImageBlockParam(url.searchParams.get("block"));
	if (blockIndex === undefined) {
		sendError(400, "Missing or invalid image block index.");
		return true;
	}
	const result = await readWorkbenchPiSessionEntryImage(options, match.workbenchSessionId, match.entryId, blockIndex);
	if (result.status === "found") {
		sendImage(result.image);
	} else if (result.status === "pending") {
		sendError(404, "Session is not ready yet.");
	} else if (result.status === "missing") {
		sendError(404, "Session not found.");
	} else {
		sendError(404, "Image not found.");
	}
	return true;
}

/**
 * Serve both read-only pi session record endpoints — the paginated timeline
 * and the inline entry image — from one dispatch point. Returns false when the
 * request matches neither endpoint so the caller can fall through to other
 * routes.
 */
export async function handleWorkbenchPiSessionRecordRequests(
	options: Pick<WorkbenchPiTimelineOptions, "workingDir" | "sessionDir">,
	method: string | undefined,
	url: URL,
	sendTimeline: (body: WorkbenchPiSessionTimeline) => void,
	sendImage: (image: WorkbenchPiSessionImage) => void,
	sendError: (status: number, message: string) => void,
): Promise<boolean> {
	if (await handleWorkbenchPiTimelineRequest(options, method, url, sendTimeline)) return true;
	return handleWorkbenchPiSessionImageRequest(options, method, url, sendImage, sendError);
}

/**
 * Fast read-only resolution of a pi session file by id, using pi's on-disk
 * naming convention (<fileTimestamp>_<sessionId>.jsonl). Falls back to the
 * existing SessionManager.list wiring when the fast path does not match.
 */
async function resolvePiSessionPath(sessionDir: string, workingDir: string, piSessionId: string): Promise<string | undefined> {
	if (PI_SESSION_ID_PATTERN.test(piSessionId)) {
		const suffix = `_${piSessionId}${PI_SESSION_FILE_SUFFIX}`;
		try {
			const candidates = readdirSync(sessionDir)
				.filter((name) => name.endsWith(suffix))
				.map((name) => join(sessionDir, name))
				.filter((path) => statSync(path).isFile())
				.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
			if (candidates[0]) return candidates[0];
		} catch {
			// Fall through to the full listing below.
		}
	}
	const sessions = await SessionManager.list(workingDir, sessionDir);
	const session = sessions.find((item) => item.id === piSessionId);
	return session?.path;
}

/**
 * Read one session file exactly once and parse it with pi's own parser.
 * Malformed lines — including a partial final line written mid-turn — are
 * skipped; the file itself is never modified.
 */
function readTimelineFileEntries(sessionPath: string): { fileEntries: FileEntry[]; header: SessionHeader | null } {
	const content = readFileSync(sessionPath, "utf8");
	const fileEntries = parseSessionEntries(content);
	const headerRecord = fileEntries.find((entry) => entry.type === "session");
	const header = headerRecord && typeof (headerRecord as SessionHeader).id === "string"
		? headerRecord as SessionHeader
		: null;
	return { fileEntries, header };
}

export async function readWorkbenchPiSessionTimeline(options: WorkbenchPiTimelineOptions): Promise<WorkbenchPiSessionTimeline> {
	const workbenchSessionId = options.workbenchSessionId;
	const piSessionId = options.piSessionId?.trim() || workbenchPiSessionId(workbenchSessionId);
	const sessionRef: WorkbenchPiTimelineSessionRef = {
		id: piSessionId,
		workbenchSessionId,
		status: options.sessionDir ? "missing" : "pending",
	};
	if (!options.sessionDir) return notReadyTimeline("pending", sessionRef);

	let sessionPath: string | undefined;
	try {
		sessionPath = await resolvePiSessionPath(options.sessionDir, options.workingDir, piSessionId);
	} catch {
		sessionPath = undefined;
	}
	if (!sessionPath) return notReadyTimeline("missing", sessionRef);

	let fileEntries: FileEntry[];
	let header: SessionHeader | null;
	try {
		({ fileEntries, header } = readTimelineFileEntries(sessionPath));
	} catch {
		// Unreadable or vanished between listing and read: clean not-ready shape.
		return notReadyTimeline("missing", sessionRef);
	}
	if (!header) {
		// File exists but no parsable header yet (first flush or a brief
		// truncate-then-fill rewrite window): not ready, retry later.
		return notReadyTimeline("pending", sessionRef);
	}

	// In-memory, non-persisting SessionManager: full branch/tree semantics of
	// pi's own implementation with zero writes to the session file.
	let branch: SessionEntry[];
	let leafId: string | undefined;
	let sessionName: string | undefined;
	let allEntries: WorkbenchPiTimelineEntry[];
	try {
		const manager = SessionManager.inMemory(header.cwd || options.workingDir, { id: header.id }, fileEntries);
		branch = manager.getBranch();
		leafId = manager.getLeafId() ?? undefined;
		sessionName = manager.getSessionName();
		const maxContentChars = clampCount(
			options.maxContentChars,
			DEFAULT_MAX_CONTENT_CHARS,
			MIN_MAX_CONTENT_CHARS,
			MAX_MAX_CONTENT_CHARS,
		);
		allEntries = buildWorkbenchPiTimelineEntries(branch, maxContentChars);
	} catch {
		// Corrupt-but-headered file: degrade to the not-ready shape instead of failing.
		return notReadyTimeline("pending", sessionRef);
	}
	const page = paginateTimelinePage(allEntries, {
		before: options.before,
		after: options.after,
		entry: options.entry,
		limit: options.limit,
		maxPageChars: options.maxPageChars,
	});

	let updatedAt: string | undefined;
	try {
		updatedAt = statSync(sessionPath).mtime.toISOString();
	} catch {
		updatedAt = undefined;
	}

	if (options.entry !== undefined && page.entries.length === 1) {
		// Single-entry fetch: serve the requested entry at full fidelity so a
		// bounded preview can be expanded without re-serializing the session.
		const fullEntry = buildFullWorkbenchPiTimelineEntry(branch, options.entry);
		if (fullEntry) page.entries = [{ ...fullEntry, seq: page.entries[0]!.seq }];
	}

	return {
		status: "active",
		session: {
			...sessionRef,
			status: "active",
			path: sessionPath,
			fileName: basename(sessionPath),
			cwd: header.cwd,
			createdAt: header.timestamp,
			updatedAt,
			leafId,
			name: sessionName,
		},
		entries: page.entries,
		pagination: page.pagination,
	};
}
