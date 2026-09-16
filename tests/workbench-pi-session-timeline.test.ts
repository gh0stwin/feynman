import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	buildFullWorkbenchPiTimelineEntry,
	buildWorkbenchPiTimelineEntries,
	DEFAULT_MAX_PAGE_CHARS,
	MAX_TIMELINE_LIMIT,
	paginateTimelinePage,
	readWorkbenchPiSessionTimeline,
	type WorkbenchPiTimelineEntry,
} from "../src/workbench/pi-session-timeline.js";
import { workbenchPiSessionId } from "../src/workbench/pi-session.js";
import { startWorkbenchServer } from "../src/workbench/server.js";

const PI_SESSION_ID = "feynman-workbench-session-timeline-test";

function usage(): Record<string, unknown> {
	return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
}

function syntheticBranchEntries(): SessionEntry[] {
	return [
		{
			type: "session",
			id: "s0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "Find the answer", timestamp: 1 },
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "a2",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I should look up the file first." },
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "notes.md" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: usage(),
				stopReason: "toolUse",
				timestamp: 2,
			},
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "t3",
			parentId: "a2",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				details: { path: "notes.md" },
				timestamp: 3,
			},
		} as unknown as SessionEntry,
		{
			type: "custom",
			id: "c4",
			parentId: "t3",
			timestamp: "2026-01-01T00:00:04.000Z",
			customType: "web-search-results",
			data: { query: "answer" },
		} as unknown as SessionEntry,
		{
			type: "custom_message",
			id: "cm5",
			parentId: "c4",
			timestamp: "2026-01-01T00:00:05.000Z",
			customType: "context-note",
			content: "Background context",
			display: true,
			details: { source: "extension" },
		} as unknown as SessionEntry,
		{
			type: "compaction",
			id: "co6",
			parentId: "cm5",
			timestamp: "2026-01-01T00:00:06.000Z",
			summary: "Summary of earlier work",
			firstKeptEntryId: "m1",
			tokensBefore: 900,
		} as unknown as SessionEntry,
		{
			type: "branch_summary",
			id: "bs7",
			parentId: "co6",
			timestamp: "2026-01-01T00:00:07.000Z",
			fromId: "m1",
			summary: "Summary of abandoned branch",
		} as unknown as SessionEntry,
		{
			type: "session_info",
			id: "si8",
			parentId: "bs7",
			timestamp: "2026-01-01T00:00:08.000Z",
			name: "Timeline test",
		} as unknown as SessionEntry,
		{
			type: "model_change",
			id: "mc9",
			parentId: "si8",
			timestamp: "2026-01-01T00:00:09.000Z",
			provider: "anthropic",
			modelId: "claude-next",
		} as unknown as SessionEntry,
		{
			type: "thinking_level_change",
			id: "tl10",
			parentId: "mc9",
			timestamp: "2026-01-01T00:00:10.000Z",
			thinkingLevel: "high",
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "u11",
			parentId: "tl10",
			timestamp: "2026-01-01T00:00:11.000Z",
			message: {
				role: "bashExecution",
				command: "echo hi",
				output: "hi",
				exitCode: 0,
				cancelled: false,
				timestamp: 11,
			},
		} as unknown as SessionEntry,
	];
}

function byKind(entries: WorkbenchPiTimelineEntry[], kind: WorkbenchPiTimelineEntry["kind"]): WorkbenchPiTimelineEntry[] {
	return entries.filter((entry) => entry.kind === kind);
}

test("timeline mapping follows branch order and types thinking, tool results, custom, and metadata entries", () => {
	const entries = buildWorkbenchPiTimelineEntries(syntheticBranchEntries().slice(1));

	assert.deepEqual(entries.map((entry) => entry.seq), entries.map((_, index) => index));
	assert.deepEqual(
		entries.map((entry) => entry.kind),
		[
			"message",
			"thinking",
			"message",
			"tool_result",
			"custom",
			"custom_message",
			"compaction",
			"branch_summary",
			"session_info",
			"model_change",
			"thinking_level_change",
			"bash_execution",
		],
	);

	const user = entries[0]!;
	assert.equal(user.role, "user");
	assert.equal(user.text, "Find the answer");
	assert.equal(user.timestamp, "2026-01-01T00:00:01.000Z");

	const thinking = byKind(entries, "thinking")[0]!;
	assert.equal(thinking.id, "a2#thinking0");
	assert.equal(thinking.sourceId, "a2");
	assert.equal(thinking.contentIndex, 0);
	assert.equal(thinking.text, "I should look up the file first.");

	const assistant = byKind(entries, "message").find((entry) => entry.role === "assistant")!;
	assert.equal(assistant.id, "a2");
	assert.equal(assistant.model, "anthropic/claude-test");
	assert.equal(assistant.stopReason, "toolUse");
	assert.equal(assistant.usage?.costTotal, 0.3);
	const toolCallBlock = assistant.blocks?.find((block) => block.type === "toolCall");
	assert.equal(toolCallBlock?.toolCallId, "tc-1");
	assert.equal(toolCallBlock?.toolName, "read");
	assert.equal(toolCallBlock?.arguments, "{\"path\":\"notes.md\"}");
	assert.equal(assistant.blocks?.some((block) => block.type === "thinking"), false);

	const toolResult = byKind(entries, "tool_result")[0]!;
	assert.equal(toolResult.toolCallId, "tc-1");
	assert.equal(toolResult.toolName, "read");
	assert.equal(toolResult.assistantId, "a2");
	assert.equal(toolResult.isError, false);
	assert.equal(toolResult.text, "file body");
	assert.deepEqual(toolResult.details, { path: "notes.md" });

	const custom = byKind(entries, "custom")[0]!;
	assert.equal(custom.customType, "web-search-results");
	assert.deepEqual(custom.details, { query: "answer" });

	const customMessage = byKind(entries, "custom_message")[0]!;
	assert.equal(customMessage.customType, "context-note");
	assert.equal(customMessage.display, true);
	assert.equal(customMessage.text, "Background context");

	const compaction = byKind(entries, "compaction")[0]!;
	assert.equal(compaction.summary, "Summary of earlier work");
	assert.equal(compaction.firstKeptEntryId, "m1");
	assert.equal(compaction.tokensBefore, 900);

	const branchSummary = byKind(entries, "branch_summary")[0]!;
	assert.equal(branchSummary.fromId, "m1");

	const sessionInfo = byKind(entries, "session_info")[0]!;
	assert.equal(sessionInfo.name, "Timeline test");

	const modelChange = byKind(entries, "model_change")[0]!;
	assert.equal(modelChange.provider, "anthropic");
	assert.equal(modelChange.modelId, "claude-next");

	const thinkingLevel = byKind(entries, "thinking_level_change")[0]!;
	assert.equal(thinkingLevel.thinkingLevel, "high");

	const bash = byKind(entries, "bash_execution")[0]!;
	assert.equal(bash.command, "echo hi");
	assert.equal(bash.output, "hi");
	assert.equal(bash.exitCode, 0);
});

test("timeline mapping bounds oversized content and reports truncation", () => {
	const longText = "x".repeat(5_000);
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: longText }],
				api: "a",
				provider: "p",
				model: "m",
				usage: usage(),
				stopReason: "stop",
				timestamp: 1,
			},
		} as unknown as SessionEntry,
	];
	const capped = buildWorkbenchPiTimelineEntries(branch, 1_000);
	const thinking = capped.find((entry) => entry.kind === "thinking")!;
	assert.equal(thinking.text?.length, 1_000);
	assert.equal(thinking.truncated, true);
	assert.equal(thinking.fullLength, 5_000);

	const full = buildFullWorkbenchPiTimelineEntry(branch, "a1#thinking0");
	assert.equal(full?.text, longText);
	assert.equal(full?.truncated, undefined);
});

test("timeline pagination serves the newest tail first and walks backward with before cursors", () => {
	const entries = buildWorkbenchPiTimelineEntries(
		syntheticBranchEntries().slice(1).map((entry, index) => ({
			...entry,
			message: entry.type === "message" ? entry.message : undefined,
		} as SessionEntry)),
		10_000,
	);
	// Deterministic small pages: rebuild with small limit through paginate.
	const tail = paginateTimelinePage(entries, { limit: 4 });
	assert.equal(tail.entries.length, 4);
	assert.equal(tail.pagination.total, entries.length);
	assert.equal(tail.pagination.hasOlder, true);
	assert.equal(tail.pagination.hasNewer, false);
	assert.equal(tail.entries[0]!.id, tail.pagination.olderCursor);
	assert.equal(tail.entries.at(-1)!.id, entries.at(-1)!.id);

	const older = paginateTimelinePage(entries, { before: tail.pagination.olderCursor, limit: 4 });
	assert.equal(older.entries.length, 4);
	assert.ok(older.entries.every((entry) => entry.seq < tail.entries[0]!.seq));
	assert.equal(older.entries.at(-1)!.seq, tail.entries[0]!.seq - 1);
	assert.equal(older.pagination.hasOlder, true);
	assert.equal(older.entries[0]!.id, older.pagination.olderCursor);
	assert.equal(older.pagination.hasNewer, true);
	// Resuming forward from the last entry of this page yields the original tail.
	assert.equal(older.pagination.newerCursor, older.entries.at(-1)!.id);
	assert.deepEqual(
		paginateTimelinePage(entries, { after: older.pagination.newerCursor, limit: 4 }).entries.map((entry) => entry.id),
		tail.entries.map((entry) => entry.id),
	);

	const walk: string[] = [];
	const walkedPages: string[][] = [];
	let cursor: string | undefined;
	let remaining = entries.length;
	while (remaining > 0) {
		const page = paginateTimelinePage(entries, { before: cursor, limit: 4 });
		if (!page.entries.length) break;
		walkedPages.push(page.entries.map((entry) => entry.id));
		remaining -= page.entries.length;
		cursor = page.pagination.hasOlder ? page.pagination.olderCursor : undefined;
		if (!cursor) break;
	}
	walk.push(...walkedPages.flat());
	assert.equal(walk.length, entries.length);
	// Pages arrive newest-first while each page is chronological; reversing the
	// page list must reproduce the full chronological stream.
	assert.deepEqual(walkedPages.reverse().flat(), entries.map((entry) => entry.id));
	assert.equal(paginateTimelinePage(entries, { before: entries[0]!.id }).entries.length, 0);
});

test("timeline pagination serves incremental tail updates with after cursors", () => {
	const entries = buildWorkbenchPiTimelineEntries(syntheticBranchEntries().slice(1));
	const tail = paginateTimelinePage(entries, { limit: 3 });
	const after = paginateTimelinePage(entries, { after: tail.entries[0]!.id, limit: 100 });
	assert.deepEqual(
		after.entries.map((entry) => entry.id),
		entries.slice(entries.length - tail.entries.length + 1).map((entry) => entry.id),
	);
	assert.equal(after.pagination.hasNewer, false);
	assert.equal(after.pagination.total, entries.length);

	// Polling after the last known entry while no new entry has flushed yet must
	// return a clean empty page, not crash.
	const last = entries.at(-1)!;
	const poll = paginateTimelinePage(entries, { after: last.id, limit: 100 });
	assert.deepEqual(poll.entries, []);
	assert.equal(poll.pagination.count, 0);
	assert.equal(poll.pagination.hasNewer, false);
	assert.equal(poll.pagination.hasOlder, true);
	assert.equal(poll.pagination.total, entries.length);
});

test("timeline pagination respects the page content budget and handles unknown cursors cleanly", () => {
	const entries: WorkbenchPiTimelineEntry[] = Array.from({ length: 6 }, (_, index) => ({
		id: `e${index}`,
		kind: "message",
		seq: index,
		text: "y".repeat(600),
	}));
	const page = paginateTimelinePage(entries, { limit: MAX_TIMELINE_LIMIT, maxPageChars: 1_500 });
	assert.equal(page.entries.length, 2);
	assert.equal(page.pagination.hasOlder, true);
	assert.equal(page.pagination.total, 6);

	const unknown = paginateTimelinePage(entries, { before: "nope" });
	assert.equal(unknown.entries.length, 0);
	assert.equal(unknown.pagination.total, 6);
	assert.equal(unknown.pagination.count, 0);
	assert.equal(unknown.pagination.hasOlder, false);
});

test("timeline pagination clamps limits", () => {
	const entries: WorkbenchPiTimelineEntry[] = Array.from({ length: 12 }, (_, index) => ({
		id: `c${index}`,
		kind: "message",
		seq: index,
		text: "z",
	}));
	assert.equal(paginateTimelinePage(entries, { limit: 10_000 }).entries.length, 12);
	assert.equal(paginateTimelinePage(entries, { limit: 0 }).entries.length, 1);
});

function makeTimelineWorkspace(): { root: string; sessionDir: string } {
	const root = mkdtempSync(join(tmpdir(), "feynman-pi-session-timeline-"));
	const sessionDir = join(root, "pi-sessions");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(root, "outputs"), { recursive: true });
	return { root, sessionDir };
}

function fixtureFileLine(entry: Record<string, unknown>): string {
	return JSON.stringify(entry);
}

function writePiSessionFixture(sessionDir: string, options: { fileName?: string; partialTail?: boolean } = {}): string {
	const fileName = options.fileName ?? `2026-01-01T00-00-00-000Z_${PI_SESSION_ID}.jsonl`;
	const lines = [
		fixtureFileLine({
			type: "session",
			version: 3,
			id: PI_SESSION_ID,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/timeline-ws",
		}),
		fixtureFileLine({
			type: "session_info",
			id: "si0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.500Z",
			name: "Fixture run",
		}),
		fixtureFileLine({
			type: "message",
			id: "m1",
			parentId: "si0",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "Question for the agent", timestamp: 1 },
		}),
		// An abandoned branch line stored BEFORE the current branch entries:
		// the stream must follow the tree (getBranch), not file order.
		fixtureFileLine({
			type: "message",
			id: "abandoned",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "abandoned branch" }], provider: "p", model: "m", stopReason: "stop", timestamp: 2 },
		}),
		fixtureFileLine({
			type: "message",
			id: "a3",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Reasoning about the question" },
					{ type: "text", text: "Working on it" },
					{ type: "toolCall", id: "tc-fix-1", name: "search", arguments: { query: "answer" } },
				],
				provider: "anthropic",
				model: "claude-test",
				usage: usage(),
				stopReason: "toolUse",
				timestamp: 3,
			},
		}),
		fixtureFileLine({
			type: "message",
			id: "t4",
			parentId: "a3",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tc-fix-1",
				toolName: "search",
				content: [{ type: "text", text: "result body" }],
				isError: false,
				timestamp: 4,
			},
		}),
		fixtureFileLine({
			type: "custom",
			id: "c5",
			parentId: "t4",
			timestamp: "2026-01-01T00:00:05.000Z",
			customType: "web-search-results",
			data: { cached: true },
		}),
		fixtureFileLine({
			type: "message",
			id: "a6",
			parentId: "c5",
			timestamp: "2026-01-01T00:00:06.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Final answer" }],
				provider: "anthropic",
				model: "claude-test",
				usage: usage(),
				stopReason: "stop",
				timestamp: 6,
			},
		}),
	];
	let content = `${lines.join("\n")}\n`;
	if (options.partialTail) {
		// A partial final line mid-turn: no trailing newline, truncated JSON.
		content += '{"type":"message","id":"partial7","parentId":"a6","timestamp":"2026-01-01T00:00:07.000Z","mess';
	}
	const path = join(sessionDir, fileName);
	writeFileSync(path, content, "utf8");
	return path;
}

test("readWorkbenchPiSessionTimeline returns the branch chronologically from a synthetic JSONL and ignores a partial final line", async (t) => {
	const { root, sessionDir } = makeTimelineWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionPath = writePiSessionFixture(sessionDir, { partialTail: true });
	const sizeBefore = statSync(sessionPath).size;
	const contentBefore = readFileSync(sessionPath, "utf8");

	const result = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
	});

	assert.equal(result.status, "active");
	assert.equal(result.session.id, PI_SESSION_ID);
	assert.equal(result.session.workbenchSessionId, "session-timeline-test");
	assert.equal(result.session.name, "Fixture run");
	assert.equal(result.session.leafId, "a6");
	assert.equal(result.session.cwd, "/tmp/timeline-ws");

	const ids = result.entries.map((entry) => entry.id);
	// Branch follows the tree: the abandoned assistant entry is excluded.
	assert.equal(ids.includes("abandoned"), false);
	assert.deepEqual(ids, ["si0", "m1", "a3#thinking0", "a3", "t4", "c5", "a6"]);

	const thinking = result.entries.find((entry) => entry.kind === "thinking")!;
	assert.equal(thinking.text, "Reasoning about the question");
	const toolResult = result.entries.find((entry) => entry.kind === "tool_result")!;
	assert.equal(toolResult.toolCallId, "tc-fix-1");
	assert.equal(toolResult.assistantId, "a3");
	assert.equal(toolResult.text, "result body");

	// The session file is untouched by the read.
	assert.equal(statSync(sessionPath).size, sizeBefore);
	assert.equal(readFileSync(sessionPath, "utf8"), contentBefore);

	// Single-entry fetch at full fidelity.
	const single = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
		entry: "c5",
	});
	assert.equal(single.entries.length, 1);
	assert.deepEqual(single.entries[0]!.details, { cached: true });
	const singleThinking = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
		entry: "a3#thinking0",
	});
	assert.equal(singleThinking.entries.length, 1);
	assert.equal(singleThinking.entries[0]!.text, "Reasoning about the question");
});

test("readWorkbenchPiSessionTimeline paginates a large session with before and after cursors", async (t) => {
	const { root, sessionDir } = makeTimelineWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writePiSessionFixture(sessionDir);

	const first = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
		limit: 2,
	});
	assert.equal(first.pagination.total, 7);
	assert.equal(first.entries.length, 2);
	assert.equal(first.pagination.hasOlder, true);
	assert.equal(first.entries[0]!.id, first.pagination.olderCursor);

	const older = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
		before: first.pagination.olderCursor,
		limit: 2,
	});
	assert.equal(older.entries.at(-1)!.id, "t4");
	assert.equal(older.pagination.hasNewer, true);
	assert.equal(older.pagination.newerCursor, "t4");

	const newer = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
		after: older.entries[0]!.id,
		limit: 2,
	});
	assert.equal(newer.entries[0]!.id, older.entries[1]!.id);
});

test("readWorkbenchPiSessionTimeline returns clean not-ready shapes for missing and pending sessions", async (t) => {
	const { root, sessionDir } = makeTimelineWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const missing = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-never-started",
	});
	assert.equal(missing.status, "missing");
	assert.equal(missing.session.id, workbenchPiSessionId("session-never-started"));
	assert.deepEqual(missing.entries, []);
	assert.equal(missing.pagination.total, 0);

	const pending = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		workbenchSessionId: "session-never-started",
	});
	assert.equal(pending.status, "pending");
	assert.deepEqual(pending.entries, []);

	// A file with no parsable header yet is pending, not missing.
	writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${PI_SESSION_ID}.jsonl`), '{"type":"mess', "utf8");
	const pendingFile = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
	});
	assert.equal(pendingFile.status, "pending");

	// The SessionManager.list fallback resolves non-conventional file names.
	writePiSessionFixture(sessionDir, { fileName: `unusual_${PI_SESSION_ID}.jsonl` });
	const viaFallback = await readWorkbenchPiSessionTimeline({
		workingDir: root,
		sessionDir,
		workbenchSessionId: "session-timeline-test",
	});
	assert.equal(viaFallback.status, "active");
	assert.equal(viaFallback.session.fileName, `unusual_${PI_SESSION_ID}.jsonl`);
});

test("workbench server serves the timeline endpoint with the existing auth path", async (t) => {
	const { root, sessionDir } = makeTimelineWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writePiSessionFixture(sessionDir);

	const handle = await startWorkbenchServer({
		workingDir: root,
		version: "0.0.0-test",
		host: "127.0.0.1",
		port: 0,
		token: "test-token",
		sessionDir,
	});
	try {
		const url = `${handle.url}api/chat/session/session-timeline-test/timeline`;
		const authorized = await fetch(url, {
			headers: { cookie: "feynman_workbench=test-token" },
		});
		assert.equal(authorized.status, 200);
		const payload = await authorized.json() as {
			status: string;
			session: { id: string };
			entries: Array<{ id: string; kind: string }>;
			pagination: { total: number };
		};
		assert.equal(payload.status, "active");
		assert.equal(payload.session.id, PI_SESSION_ID);
		assert.equal(payload.pagination.total, 7);
		assert.ok(payload.entries.some((entry) => entry.kind === "thinking"));
		assert.ok(payload.entries.some((entry) => entry.kind === "tool_result"));

		const unauthorized = await fetch(url);
		assert.equal(unauthorized.status, 401);

		const paginated = await fetch(`${url}?limit=2&before=${encodeURIComponent("a3#thinking0")}`, {
			headers: { cookie: "feynman_workbench=test-token" },
		});
		assert.equal(paginated.status, 200);
		const paginatedPayload = await paginated.json() as { entries: Array<{ id: string }>; pagination: { count: number } };
		assert.equal(paginatedPayload.pagination.count, 2);
		assert.deepEqual(paginatedPayload.entries.map((entry) => entry.id), ["si0", "m1"]);

		const unknown = await fetch(`${handle.url}api/chat/session/session-unknown/timeline`, {
			headers: { cookie: "feynman_workbench=test-token" },
		});
		assert.equal(unknown.status, 200);
		const unknownPayload = await unknown.json() as { status: string };
		assert.equal(unknownPayload.status, "missing");
	} finally {
		await handle.close();
	}
});
