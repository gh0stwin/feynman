import { Brain, ChevronDown } from "lucide-react";

import type {
	WorkbenchChatMessage,
	WorkbenchPiSessionTimeline,
	WorkbenchPiTimelineEntry,
} from "./types.js";

export type ThoughtCardGroups = {
	/** Thinking entries attached per assistant message id, in timeline order. */
	byMessageId: Map<string, WorkbenchPiTimelineEntry[]>;
	/** Thinking entries with no assistant message body to render inside. */
	orphans: WorkbenchPiTimelineEntry[];
};

/**
 * Attach thinking-kind timeline entries to the assistant chat messages they
 * belong to, so the cards render inside the agent's message body like tool
 * activity does. The chat records one assistant reply per user submit, but the
 * pi timeline can hold more assistant turns than the chat has messages: every
 * user submit starts a turn, and a message steered into a running turn makes pi
 * emit an extra assistant turn with no chat counterpart. Turns are therefore
 * correlated by user-message order rather than by assistant-message index: the
 * n-th timeline user entry and the n-th chat user message are the same prompt,
 * so the assistant turn after the n-th timeline user belongs to the chat
 * assistant (if any) that answers the n-th chat user. A thinking entry carries
 * the pi id of its own assistant turn as `sourceId` and is attached to that
 * turn's chat assistant; a steered turn with no chat assistant is returned as
 * an orphan rather than misattributed to a later reply. Timeline order is
 * preserved.
 */
export function thoughtCardGroups(
	messages: WorkbenchChatMessage[],
	entries: WorkbenchPiTimelineEntry[],
): ThoughtCardGroups {
	const groups: ThoughtCardGroups = { byMessageId: new Map(), orphans: [] };
	// For each chat user message in order, the assistant message that answers it,
	// or none when the user message was queued/steered into a running turn.
	const assistantForTurn: Array<string | undefined> = [];
	messages.forEach((message, index) => {
		if (message.role !== "user") return;
		const next = messages[index + 1];
		assistantForTurn.push(next && next.role === "assistant" ? next.id : undefined);
	});
	// Attribute each pi assistant entry to the chat assistant of its turn. A turn
	// runs from one timeline user entry up to the next, so the running count of
	// user entries seen identifies the turn an assistant belongs to.
	const turnIdToChatId = new Map<string, string>();
	let segment = -1;
	for (const entry of entries) {
		if (entry.kind === "message" && entry.role === "user") {
			segment++;
			continue;
		}
		if (entry.kind !== "message" || entry.role !== "assistant" || !entry.id) continue;
		const chatId = assistantForTurn[segment];
		if (chatId) turnIdToChatId.set(entry.id, chatId);
	}
	for (const entry of entries) {
		if (entry.kind !== "thinking") continue;
		const messageId = entry.sourceId ? turnIdToChatId.get(entry.sourceId) : undefined;
		if (messageId === undefined) {
			groups.orphans.push(entry);
			continue;
		}
		const group = groups.byMessageId.get(messageId);
		if (group) group.push(entry);
		else groups.byMessageId.set(messageId, [entry]);
	}
	return groups;
}

/**
 * Fetch every page of the pi session timeline so thinking entries stay attached
 * to the correct turn even in long sessions that exceed the newest-N page the
 * server returns by default. Walks the `before` cursor back to the oldest entry
 * and returns the complete record in chronological order.
 */
export async function fetchCompleteTimeline(
	fetchPage: (before?: string) => Promise<WorkbenchPiSessionTimeline>,
): Promise<WorkbenchPiTimelineEntry[]> {
	const pages: WorkbenchPiTimelineEntry[][] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 500; guard++) {
		const page = await fetchPage(cursor);
		pages.push(page.entries);
		if (!page.pagination.hasOlder || !page.pagination.olderCursor) break;
		cursor = page.pagination.olderCursor;
	}
	return pages.reverse().flat();
}

/** Compact clock label for the collapsed card header. */
export function thoughtCardTimeLabel(value?: string): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function thoughtBody(entry: WorkbenchPiTimelineEntry): string | undefined {
	if (entry.text) return entry.text;
	return entry.redacted ? "Reasoning was withheld by the model (redacted)." : undefined;
}

/**
 * Collapsible card for one agent thinking entry from the pi timeline.
 * Mirrors the tool-card structure; collapsed by default via native
 * `details`/`summary`, with the thinking text visible only when expanded.
 */
export function ThoughtCard({ entry }: { entry: WorkbenchPiTimelineEntry }) {
	const timeLabel = thoughtCardTimeLabel(entry.timestamp);
	const body = thoughtBody(entry);
	return (
		<section className="thought-card" data-testid="thought-card">
			<details className="thought-card-details">
				<summary className="thought-card-header">
					<span className="thought-card-title">
						<Brain size={13} aria-hidden />
						<strong>Thinking</strong>
						{timeLabel ? <span>{timeLabel}</span> : null}
					</span>
					<ChevronDown size={14} aria-hidden className="thought-card-chevron" />
				</summary>
				{body ? <pre className="thought-card-body">{body}</pre> : null}
				{entry.truncated && entry.fullLength !== undefined ? (
					<p className="thought-card-truncated">
						Preview truncated — showing the first {entry.text?.length ?? 0} of {entry.fullLength} characters.
					</p>
				) : null}
			</details>
		</section>
	);
}
