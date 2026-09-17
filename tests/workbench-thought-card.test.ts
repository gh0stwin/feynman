import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	ThoughtCard,
	fetchCompleteTimeline,
	thoughtCardGroups,
	thoughtCardTimeLabel,
} from "../workbench-web/src/thought-cards.js";
import type {
	WorkbenchChatMessage,
	WorkbenchPiSessionTimeline,
	WorkbenchPiTimelineEntry,
} from "../workbench-web/src/types.js";

function chatMessage(id: string, role: "user" | "assistant", createdAt: string): WorkbenchChatMessage {
	return { id, role, content: `${id} content`, createdAt, status: "complete", toolEvents: [] };
}

function thinkingEntry(
	id: string,
	timestamp?: string,
	extra: Partial<WorkbenchPiTimelineEntry> = {},
): WorkbenchPiTimelineEntry {
	return {
		id,
		kind: "thinking",
		seq: 0,
		...(timestamp ? { timestamp } : {}),
		text: `${id} reasoning text`,
		...extra,
	};
}

function assistantEntry(id: string): WorkbenchPiTimelineEntry {
	return { id, kind: "message", seq: 0, role: "assistant", text: `${id} reply` };
}

function userEntry(id: string): WorkbenchPiTimelineEntry {
	return { id, kind: "message", seq: 0, role: "user", text: `${id} prompt` };
}

function timelinePage(
	entries: WorkbenchPiTimelineEntry[],
	hasOlder: boolean,
	olderCursor?: string,
): WorkbenchPiSessionTimeline {
	return {
		status: "active",
		session: { id: "s", workbenchSessionId: "s", status: "active" },
		entries,
		pagination: { total: 0, count: entries.length, hasOlder, olderCursor, hasNewer: false },
	};
}

function renderThoughtCard(entry: WorkbenchPiTimelineEntry): string {
	return renderToStaticMarkup(createElement(ThoughtCard, { entry }));
}

test("thought card renders collapsed by default with a compact header", () => {
	const html = renderThoughtCard(thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z"));
	assert.match(html, /<section class="thought-card" data-testid="thought-card">/);
	assert.match(html, /<details class="thought-card-details">/);
	// Default collapsed: the native details toggle is never pre-opened.
	assert.equal(/<details class="thought-card-details"[^>]*\bopen\b/.test(html), false);
	assert.match(html, /<summary class="thought-card-header">/);
	assert.match(html, /Thinking<\/strong>/);
	assert.match(html, /reasoning text<\/pre>/);
});

test("thought card keeps thinking text inside the expandable details region", () => {
	const html = renderThoughtCard(thinkingEntry("a2#thinking0"));
	const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
	assert.match(details, /reasoning text/);
	assert.match(details, /thought-card-body/);
});

test("thought card renders a redacted thinking entry without raw reasoning text", () => {
	const html = renderThoughtCard(thinkingEntry("a2#thinking1", "2026-01-01T00:00:02.000Z", {
		text: "",
		redacted: true,
	}));
	assert.match(html, /Thinking<\/strong>/);
	assert.match(html, /Reasoning was withheld by the model \(redacted\)\./);
	assert.equal(html.includes("reasoning text"), false);
});

test("thought card shows truncation notice when preview is bounded", () => {
	const entry = thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z", {
		text: "short reasoning",
		truncated: true,
		fullLength: 1200,
	});
	const html = renderThoughtCard(entry);
	assert.match(html, /Preview truncated — showing the first 15 of 1200 characters\./);
});

test("thought card groups attach each entry to its own turn's assistant reply", () => {
	// Streaming shape: the assistant message is created at turn start (createdAt
	// before the thinking timestamp) and patched in place, never later.
	const user = chatMessage("m1", "user", "2026-01-01T00:00:01.000Z");
	const reply1 = chatMessage("m2", "assistant", "2026-01-01T00:00:01.500Z");
	const user2 = chatMessage("m3", "user", "2026-01-01T00:00:05.000Z");
	const reply2 = chatMessage("m4", "assistant", "2026-01-01T00:00:05.500Z");
	const groups = thoughtCardGroups(
		[user, reply1, user2, reply2],
		[
			userEntry("u1"),
			assistantEntry("a2"),
			thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z", { sourceId: "a2" }),
			userEntry("u2"),
			assistantEntry("b2"),
			thinkingEntry("b2#thinking0", "2026-01-01T00:00:07.000Z", { sourceId: "b2" }),
		],
	);
	assert.equal(groups.orphans.length, 0);
	assert.deepEqual([...groups.byMessageId.keys()], ["m2", "m4"]);
	assert.deepEqual(groups.byMessageId.get("m2")!.map((entry) => entry.id), ["a2#thinking0"]);
	assert.deepEqual(groups.byMessageId.get("m4")!.map((entry) => entry.id), ["b2#thinking0"]);
});

test("thought card groups keep multiple entries of one turn in timeline order", () => {
	const reply = chatMessage("m2", "assistant", "2026-01-01T00:00:01.500Z");
	const groups = thoughtCardGroups(
		[chatMessage("m1", "user", "2026-01-01T00:00:01.000Z"), reply],
		[
			userEntry("u1"),
			assistantEntry("a2"),
			thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z", { sourceId: "a2" }),
			thinkingEntry("a2#thinking1", "2026-01-01T00:00:03.000Z", { sourceId: "a2" }),
		],
	);
	assert.equal(groups.orphans.length, 0);
	assert.deepEqual(
		groups.byMessageId.get("m2")!.map((entry) => entry.id),
		["a2#thinking0", "a2#thinking1"],
	);
});

test("thought card groups skip steered turns that have no chat assistant", () => {
	// After the first reply the user steers into the running turn: the chat
	// records only a queued user message, but pi emits an extra assistant turn.
	// That steered turn's thinking must not attach to the next real reply.
	const user1 = chatMessage("m1", "user", "2026-01-01T00:00:01.000Z");
	const reply1 = chatMessage("m2", "assistant", "2026-01-01T00:00:01.500Z");
	const steer = chatMessage("m3", "user", "2026-01-01T00:00:03.000Z");
	const user2 = chatMessage("m4", "user", "2026-01-01T00:00:06.000Z");
	const reply2 = chatMessage("m5", "assistant", "2026-01-01T00:00:06.500Z");
	const groups = thoughtCardGroups(
		[user1, reply1, steer, user2, reply2],
		[
			userEntry("u1"),
			assistantEntry("a1"),
			thinkingEntry("a1#t0", "2026-01-01T00:00:02.000Z", { sourceId: "a1" }),
			userEntry("u2"),
			assistantEntry("a2"),
			thinkingEntry("a2#t0", "2026-01-01T00:00:04.000Z", { sourceId: "a2" }),
			userEntry("u3"),
			assistantEntry("a3"),
			thinkingEntry("a3#t0", "2026-01-01T00:00:07.000Z", { sourceId: "a3" }),
		],
	);
	assert.deepEqual(groups.byMessageId.get("m2")!.map((entry) => entry.id), ["a1#t0"]);
	assert.deepEqual(groups.byMessageId.get("m5")!.map((entry) => entry.id), ["a3#t0"]);
	assert.equal(groups.byMessageId.has("m2"), true);
	assert.equal(groups.byMessageId.has("m5"), true);
	assert.deepEqual(groups.orphans.map((entry) => entry.id), ["a2#t0"]);
});

test("thought card groups ignore non-thinking timeline entries", () => {
	const groups = thoughtCardGroups([chatMessage("m1", "user", "2026-01-01T00:00:01.000Z")], [
		userEntry("u1"),
		{ id: "a2", kind: "message", seq: 0, role: "assistant", text: "answer" },
		{ id: "c1", kind: "compaction", seq: 1, summary: "compacted" },
	]);
	assert.equal(groups.byMessageId.size, 0);
	assert.equal(groups.orphans.length, 0);
});

test("thought card groups attach a running turn's thinking to its own placeholder", () => {
	// The streaming assistant placeholder is the primary reply of its own turn,
	// so the thinking of that turn attaches to it rather than being parked.
	const user = chatMessage("m1", "user", "2026-01-01T00:00:01.000Z");
	const placeholder = chatMessage("m2", "assistant", "2026-01-01T00:00:01.500Z");
	const groups = thoughtCardGroups(
		[user, placeholder],
		[
			userEntry("u1"),
			assistantEntry("a2"),
			thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z", { sourceId: "a2" }),
		],
	);
	assert.equal(groups.orphans.length, 0);
	assert.deepEqual(groups.byMessageId.get("m2")!.map((entry) => entry.id), ["a2#thinking0"]);
});

test("thought card groups return orphans when no assistant message exists", () => {
	const entry = thinkingEntry("a2#thinking0", "2026-01-01T00:00:02.000Z");
	const groups = thoughtCardGroups(
		[chatMessage("m1", "user", "2026-01-01T00:00:01.000Z")],
		[userEntry("u1"), entry],
	);
	assert.equal(groups.byMessageId.size, 0);
	assert.deepEqual(groups.orphans, [entry]);
});

test("fetchCompleteTimeline walks all pages back to the oldest entry", async () => {
	const entry = (id: string): WorkbenchPiTimelineEntry => ({ id, kind: "message", seq: 0, role: "assistant", text: id });
	const pages: WorkbenchPiSessionTimeline[] = [
		timelinePage([entry("e8"), entry("e9")], true, "e8"),
		timelinePage([entry("e6"), entry("e7")], true, "e6"),
		timelinePage([entry("e4"), entry("e5")], true, "e4"),
		timelinePage([entry("e2"), entry("e3")], true, "e2"),
		timelinePage([entry("e0"), entry("e1")], false),
	];
	const cursors: Array<string | undefined> = [];
	const entries = await fetchCompleteTimeline(async (before) => {
		cursors.push(before);
		return pages[cursors.length - 1]!;
	});
	assert.deepEqual(cursors, [undefined, "e8", "e6", "e4", "e2"]);
	assert.deepEqual(entries.map((item) => item.id), ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
});

test("thought card time label is empty for missing or invalid timestamps", () => {
	assert.equal(thoughtCardTimeLabel(), "");
	assert.equal(thoughtCardTimeLabel(""), "");
	assert.equal(thoughtCardTimeLabel("not-a-date"), "");
});
