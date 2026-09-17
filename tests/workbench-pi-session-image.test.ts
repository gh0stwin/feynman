import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	buildWorkbenchPiTimelineEntries,
	handleWorkbenchPiSessionImageRequest,
	parseWorkbenchImageBlockParam,
	readWorkbenchPiSessionEntryImage,
} from "../src/workbench/pi-session-timeline.js";
import { startWorkbenchServer } from "../src/workbench/server.js";

const WORKBENCH_SESSION_ID = "session-image-test";
const PI_SESSION_ID = `feynman-workbench-${WORKBENCH_SESSION_ID}`;

// 1x1 PNG (transparent) — a realistic decodable image payload.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDA0SEhISFREWFxkYFxsYGBwcHR0dHR0dHR3/xAAaAAEBAQEBAQEAAAAAAAAAAAAAAQIDBAUG/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAEC/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";
const JPEG_BYTES = Buffer.from(JPEG_BASE64, "base64");

function makeImageWorkspace(): { root: string; sessionDir: string } {
	const root = mkdtempSync(join(tmpdir(), "feynman-pi-session-image-"));
	const sessionDir = join(root, "pi-sessions");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(root, "outputs"), { recursive: true });
	return { root, sessionDir };
}

function writeImageSessionFixture(sessionDir: string, options: { fileName?: string } = {}): string {
	const fileName = options.fileName ?? `2026-01-02T00-00-00-000Z_${PI_SESSION_ID}.jsonl`;
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: PI_SESSION_ID,
			timestamp: "2026-01-02T00:00:00.000Z",
			cwd: "/tmp/image-ws",
		}),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-02T00:00:01.000Z",
			message: {
				role: "user",
				content: [
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					{ type: "text", text: "What is in this image?" },
				],
				timestamp: 1,
			},
		}),
		JSON.stringify({
			type: "message",
			id: "a2",
			parentId: "u1",
			timestamp: "2026-01-02T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the pixels." },
					{ type: "text", text: "Looking at the image." },
					{ type: "toolCall", id: "tc-img-1", name: "screenshot", arguments: {} },
				],
				provider: "anthropic",
				model: "claude-test",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
		}),
		JSON.stringify({
			type: "message",
			id: "t3",
			parentId: "a2",
			timestamp: "2026-01-02T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tc-img-1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "Captured." },
					{ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
				],
				isError: false,
				timestamp: 3,
			},
		}),
	];
	const path = join(sessionDir, fileName);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return path;
}

test("timeline entries address image blocks by their content array position", () => {
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-02T00:00:01.000Z",
			message: {
				role: "user",
				content: [
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					{ type: "text", text: "What is in this image?" },
				],
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "t3",
			parentId: "u1",
			timestamp: "2026-01-02T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tc-img-1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "Captured." },
					{ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
				],
				isError: false,
				timestamp: 3,
			},
		},
	] as unknown as SessionEntry[];
	const entries = buildWorkbenchPiTimelineEntries(branch);

	const userEntry = entries.find((entry) => entry.kind === "message" && entry.role === "user")!;
	const userImageBlock = userEntry.blocks?.find((block) => block.type === "image");
	assert.equal(userImageBlock?.contentIndex, 0);
	assert.equal(userImageBlock?.dataOmitted, true);
	assert.equal(userImageBlock?.mimeType, "image/png");

	const toolResultEntry = entries.find((entry) => entry.kind === "tool_result")!;
	const toolImageBlock = toolResultEntry.blocks?.find((block) => block.type === "image");
	assert.equal(toolImageBlock?.contentIndex, 1);
	assert.equal(toolImageBlock?.mimeType, "image/jpeg");
});

test("parseWorkbenchImageBlockParam accepts only non-negative integers", () => {
	assert.equal(parseWorkbenchImageBlockParam("0"), 0);
	assert.equal(parseWorkbenchImageBlockParam("12"), 12);
	assert.equal(parseWorkbenchImageBlockParam(" 7 "), 7);
	assert.equal(parseWorkbenchImageBlockParam(null), undefined);
	assert.equal(parseWorkbenchImageBlockParam(""), undefined);
	assert.equal(parseWorkbenchImageBlockParam("abc"), undefined);
	assert.equal(parseWorkbenchImageBlockParam("-1"), undefined);
	assert.equal(parseWorkbenchImageBlockParam("1.5"), undefined);
	assert.equal(parseWorkbenchImageBlockParam("0x10"), undefined);
});

test("readWorkbenchPiSessionEntryImage decodes inline base64 image blocks from message content", async (t) => {
	const { root, sessionDir } = makeImageWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeImageSessionFixture(sessionDir);

	const userImage = await readWorkbenchPiSessionEntryImage(
		{ workingDir: root, sessionDir },
		WORKBENCH_SESSION_ID,
		"u1",
		0,
	);
	assert.equal(userImage.status, "found");
	if (userImage.status === "found") {
		assert.equal(userImage.image.mimeType, "image/png");
		assert.ok(userImage.image.bytes.equals(PNG_BYTES));
	}

	// Tool result image output lives at content index 1.
	const toolImage = await readWorkbenchPiSessionEntryImage(
		{ workingDir: root, sessionDir },
		WORKBENCH_SESSION_ID,
		"t3",
		1,
	);
	assert.equal(toolImage.status, "found");
	if (toolImage.status === "found") {
		assert.equal(toolImage.image.mimeType, "image/jpeg");
		assert.ok(toolImage.image.bytes.equals(JPEG_BYTES));
	}

	// Text blocks, out-of-range blocks, unknown entries, and derived ids are not images.
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "u1", 1)).status, "not-found");
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "u1", 9)).status, "not-found");
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "nope", 0)).status, "not-found");
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "a2#thinking0", 99)).status, "not-found");
});

test("readWorkbenchPiSessionEntryImage returns clean not-ready shapes for missing and pending sessions", async (t) => {
	const { root, sessionDir } = makeImageWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// No sessionDir configured: pending.
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root }, WORKBENCH_SESSION_ID, "u1", 0)).status, "pending");

	// No file for the session: missing.
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "u1", 0)).status, "missing");

	// A file with no parsable header yet: pending.
	writeFileSync(join(sessionDir, `2026-01-02T00-00-00-000Z_${PI_SESSION_ID}.jsonl`), '{"type":"mess', "utf8");
	assert.equal((await readWorkbenchPiSessionEntryImage({ workingDir: root, sessionDir }, WORKBENCH_SESSION_ID, "u1", 0)).status, "pending");
});

test("workbench server serves session images with the same auth as the timeline route", async (t) => {
	const { root, sessionDir } = makeImageWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionPath = writeImageSessionFixture(sessionDir);
	const contentBefore = readFileSync(sessionPath, "utf8");

	const handle = await startWorkbenchServer({
		workingDir: root,
		version: "0.0.0-test",
		host: "127.0.0.1",
		port: 0,
		token: "test-token",
		sessionDir,
	});
	try {
		const userImageUrl = `${handle.url}api/chat/session/${WORKBENCH_SESSION_ID}/entry/u1/image?block=0`;

		// Unauthorized requests are rejected exactly like the timeline route.
		const unauthorized = await fetch(userImageUrl);
		assert.equal(unauthorized.status, 401);

		// Cookie auth serves the decoded bytes with the recorded mimeType.
		const authorized = await fetch(userImageUrl, {
			headers: { cookie: "feynman_workbench=test-token" },
		});
		assert.equal(authorized.status, 200);
		assert.equal(authorized.headers.get("content-type"), "image/png");
		const body = Buffer.from(await authorized.arrayBuffer());
		assert.ok(body.equals(PNG_BYTES));
		assert.equal(authorized.headers.get("cache-control"), "no-store");

		// Query-token auth also works (browser <img> fallback).
		const tokenUrl = `${userImageUrl}&token=test-token`;
		const viaToken = await fetch(tokenUrl);
		assert.equal(viaToken.status, 200);
		assert.equal(viaToken.headers.get("content-type"), "image/png");

		// Tool result image output.
		const toolImage = await fetch(`${handle.url}api/chat/session/${WORKBENCH_SESSION_ID}/entry/t3/image?block=1`, {
			headers: { cookie: "feynman_workbench=test-token" },
		});
		assert.equal(toolImage.status, 200);
		assert.equal(toolImage.headers.get("content-type"), "image/jpeg");
		assert.ok(Buffer.from(await toolImage.arrayBuffer()).equals(JPEG_BYTES));

		// Session file stays untouched by image reads.
		assert.equal(readFileSync(sessionPath, "utf8"), contentBefore);
	} finally {
		await handle.close();
	}
});

test("workbench server image route handles invalid requests gracefully", async (t) => {
	const { root, sessionDir } = makeImageWorkspace();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionPath = writeImageSessionFixture(sessionDir);
	const contentBefore = readFileSync(sessionPath, "utf8");

	const handle = await startWorkbenchServer({
		workingDir: root,
		version: "0.0.0-test",
		host: "127.0.0.1",
		port: 0,
		token: "test-token",
		sessionDir,
	});
	try {
		const auth = { headers: { cookie: "feynman_workbench=test-token" } };
		const base = `${handle.url}api/chat/session/${WORKBENCH_SESSION_ID}/entry/u1/image`;

		// Invalid block parameter: 400, matching the endpoint contract.
		for (const block of [undefined, "abc", "-1", "1.5"]) {
			const url = block === undefined ? base : `${base}?block=${block}`;
			const response = await fetch(url, auth);
			assert.equal(response.status, 400, `block=${block}`);
			assert.match(await response.text(), /block/i);
		}

		// Out-of-range block, non-image block, and unknown entry: clean 404s.
		const outOfRange = await fetch(`${base}?block=9`, auth);
		assert.equal(outOfRange.status, 404);
		const textBlock = await fetch(`${base}?block=1`, auth);
		assert.equal(textBlock.status, 404);
		const unknownEntry = await fetch(`${handle.url}api/chat/session/${WORKBENCH_SESSION_ID}/entry/nope/image?block=0`, auth);
		assert.equal(unknownEntry.status, 404);

		// Unknown session: clean 404, matching the timeline endpoint's not-ready shape.
		const unknownSession = await fetch(`${handle.url}api/chat/session/session-unknown/image?block=0`, auth);
		assert.equal(unknownSession.status, 404);

		// Non-GET requests fall through to the generic 404.
		const post = await fetch(`${base}?block=0`, { method: "POST", headers: auth.headers });
		assert.equal(post.status, 404);

		// The session file is still untouched by all of these requests.
		assert.equal(readFileSync(sessionPath, "utf8"), contentBefore);
	} finally {
		await handle.close();
	}
});

test("handleWorkbenchPiSessionImageRequest falls through for non-image paths", async () => {
	let called = false;
	const sendImage = (): void => {
		called = true;
	};
	const sendError = (): void => {
		called = true;
	};

	const timelineUrl = new URL("http://localhost/api/chat/session/s1/timeline");
	assert.equal(await handleWorkbenchPiSessionImageRequest({ workingDir: "/tmp" }, "GET", timelineUrl, sendImage, sendError), false);
	const postUrl = new URL("http://localhost/api/chat/session/s1/entry/e1/image?block=0");
	assert.equal(await handleWorkbenchPiSessionImageRequest({ workingDir: "/tmp" }, "POST", postUrl, sendImage, sendError), false);
	assert.equal(called, false);

	// A matched GET always answers through one of the send callbacks.
	const okUrl = new URL("http://localhost/api/chat/session/s1/entry/e1/image?block=0");
	assert.equal(await handleWorkbenchPiSessionImageRequest({ workingDir: "/tmp" }, "GET", okUrl, sendImage, sendError), true);
	assert.equal(called, true);
});
