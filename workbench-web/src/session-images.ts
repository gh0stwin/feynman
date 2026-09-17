/**
 * Client-side index of image content in a pi-backed workbench session.
 *
 * The workbench timeline endpoint (`GET /api/chat/session/:id/timeline`) is
 * metadata-only: image blocks are never inlined, each carries the block's
 * content index plus the recorded mimeType. This module turns that metadata
 * into <img> references against the image endpoint
 * (`GET /api/chat/session/:id/entry/:entryId/image?block=N`), which decodes the
 * base64 ImageContent block straight from the pi session JSONL.
 */

export type WorkbenchSessionImageRef = {
	entryId: string;
	blockIndex: number;
	mimeType?: string;
	sizeBytes?: number;
};

export type WorkbenchSessionImageIndex = {
	/**
	 * Image refs per user-message timeline entry, in branch order — one slot
	 * for every user message entry, empty when it carries no images. The chat
	 * transcript zips these with the session's user messages by position:
	 * every workbench prompt becomes exactly one pi user message.
	 */
	userImages: WorkbenchSessionImageRef[][];
	/** Image refs per tool call id, for image outputs in tool results. */
	imagesByToolCallId: Record<string, WorkbenchSessionImageRef[]>;
};

type TimelineBlockShape = {
	type?: unknown;
	contentIndex?: unknown;
	mimeType?: unknown;
	sizeBytes?: unknown;
	dataOmitted?: unknown;
};

type TimelineEntryShape = {
	id?: unknown;
	kind?: unknown;
	role?: unknown;
	toolCallId?: unknown;
	blocks?: unknown;
};

const EMPTY_INDEX: WorkbenchSessionImageIndex = { userImages: [], imagesByToolCallId: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageRefFromBlock(entryId: string, block: TimelineBlockShape): WorkbenchSessionImageRef | undefined {
	if (block.type !== "image" || block.dataOmitted !== true) return undefined;
	const blockIndex = block.contentIndex;
	if (typeof blockIndex !== "number" || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return undefined;
	return {
		entryId,
		blockIndex,
		...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
		...(typeof block.sizeBytes === "number" ? { sizeBytes: block.sizeBytes } : {}),
	};
}

function imageRefsForEntry(entryId: string, blocks: unknown): WorkbenchSessionImageRef[] {
	if (!Array.isArray(blocks)) return [];
	return blocks.flatMap((block) => {
		if (!isRecord(block)) return [];
		const ref = imageRefFromBlock(entryId, block as TimelineBlockShape);
		return ref ? [ref] : [];
	});
}

/**
 * Extract image references from the timeline endpoint's metadata-only entry
 * stream. Every user-message entry gets a slot (empty when imageless) so the
 * transcript can zip by position; image outputs in tool results are keyed by
 * the tool call id shared with chat tool events.
 */
export function extractWorkbenchSessionImages(entries: unknown): WorkbenchSessionImageIndex {
	if (!Array.isArray(entries)) return EMPTY_INDEX;
	const userImages: WorkbenchSessionImageRef[][] = [];
	const imagesByToolCallId: Record<string, WorkbenchSessionImageRef[]> = {};
	for (const rawEntry of entries) {
		if (!isRecord(rawEntry)) continue;
		const entry = rawEntry as TimelineEntryShape;
		if (typeof entry.id !== "string" || !entry.id) continue;
		const refs = imageRefsForEntry(entry.id, entry.blocks);
		if (entry.kind === "message" && entry.role === "user") {
			userImages.push(refs);
		} else if (entry.kind === "tool_result" && refs.length && typeof entry.toolCallId === "string" && entry.toolCallId) {
			const existing = imagesByToolCallId[entry.toolCallId] ?? [];
			imagesByToolCallId[entry.toolCallId] = [...existing, ...refs];
		}
	}
	return { userImages, imagesByToolCallId };
}

/**
 * Images for one user chat message. Chat user messages and pi user-message
 * entries correspond one-to-one in workbench sessions, so the i-th user chat
 * message maps to the i-th user entry. The timeline window may cover only the
 * newest suffix of the session (pagination is capped), so align from the end:
 * an out-of-window user message simply has no image instead of disabling the
 * whole session. Only bail entirely when the image slots outnumber the user
 * messages, which means the timeline does not line up with the transcript.
 */
export function imagesForUserMessage(
	userImages: WorkbenchSessionImageRef[][],
	messages: Array<{ role: string }>,
	messageIndex: number,
): WorkbenchSessionImageRef[] {
	if (messages[messageIndex]?.role !== "user") return [];
	let userMessageCount = 0;
	for (let index = 0; index <= messageIndex; index++) {
		if (messages[index]?.role === "user") userMessageCount++;
	}
	const totalUserMessages = countUserMessages(messages);
	if (userImages.length > totalUserMessages) {
		return [];
	}
	const suffixOffset = totalUserMessages - userImages.length;
	const coveredIndex = userMessageCount - 1 - suffixOffset;
	return coveredIndex >= 0 ? (userImages[coveredIndex] ?? []) : [];
}

function countUserMessages(messages: Array<{ role: string }>): number {
	return messages.filter((message) => message.role === "user").length;
}

/** Build the <img> src for one session image against the image endpoint. */
export function workbenchSessionImageUrl(
	sessionId: string,
	ref: WorkbenchSessionImageRef,
	clientToken?: string | null,
): string {
	const params = new URLSearchParams({ block: String(ref.blockIndex) });
	if (clientToken) params.set("token", clientToken);
	return `/api/chat/session/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(ref.entryId)}/image?${params.toString()}`;
}
