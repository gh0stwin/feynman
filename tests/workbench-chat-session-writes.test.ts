import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	appendWorkbenchChatAssistantMessage,
	createWorkbenchStreamWriteCoalescer,
	ensureWorkbenchChatSession,
	streamWorkbenchChatMessage,
	WORKBENCH_STREAM_WRITE_COALESCE_MS,
	type WorkbenchChatMessage,
	type WorkbenchChatSession,
} from "../src/workbench/chat.js";
import { workbenchDataPath } from "../src/workbench/data-root.js";
import { defaultWorkbenchPiSessionInfo } from "../src/workbench/pi-session.js";

// Keep every session file this suite touches inside a disposable data home.
const dataHome = mkdtempSync(join(tmpdir(), "feynman-session-write-hygiene-home-"));
process.env.FEYNMAN_WORKBENCH_HOME = dataHome;

after(() => {
	rmSync(dataHome, { recursive: true, force: true });
});

function makeWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "feynman-session-write-hygiene-"));
	mkdirSync(join(root, "outputs"), { recursive: true });
	writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
	return root;
}

function sessionPath(workingDir: string, id: string): string {
	return workbenchDataPath(workingDir, "sessions", `${id}.json`);
}

function isoNow(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function makeSession(id: string): WorkbenchChatSession {
	const createdAt = isoNow();
	return {
		id,
		projectId: "workspace",
		title: "Session write probe",
		createdAt,
		updatedAt: createdAt,
		status: "complete",
		config: {
			delegation: false,
			autoReview: false,
			memory: false,
			specialist: "None",
			compute: "local",
			model: "",
		},
		piSession: defaultWorkbenchPiSessionInfo(id),
		attachments: [],
		messages: [],
	};
}

function assistantMessage(content: string, createdAt = isoNow()): WorkbenchChatMessage {
	return {
		id: "assistant-probe",
		role: "assistant",
		content,
		createdAt,
		status: "running",
		toolEvents: [],
	};
}

function readDiskSession(workingDir: string, id: string): WorkbenchChatSession {
	return JSON.parse(readFileSync(sessionPath(workingDir, id), "utf8")) as WorkbenchChatSession;
}

function withAssistantDelta(session: WorkbenchChatSession, content: string): WorkbenchChatSession {
	const withMessage = session.messages.some((message) => message.role === "assistant")
		? session
		: { ...session, messages: [...session.messages, assistantMessage("Starting Feynman inside this workspace...")] };
	return {
		...withMessage,
		updatedAt: isoNow(),
		messages: withMessage.messages.map((message) =>
			message.role === "assistant" ? { ...message, content } : message
		),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("workbench chat session writes materialize at <path>.tmp before the atomic rename", () => {
	const root = makeWorkspace();
	const id = "atomic-victim";
	// A directory occupies the destination path, so the final rename fails after
	// the tmp payload was already materialized. A direct non-atomic write would
	// fail without ever leaving a tmp sidecar behind.
	const victimPath = sessionPath(root, id);
	mkdirSync(victimPath, { recursive: true });
	writeFileSync(join(victimPath, "keep.txt"), "do not clobber", "utf8");

	assert.throws(() => {
		appendWorkbenchChatAssistantMessage({ workingDir: root }, makeSession(id), "the atomic payload");
	});

	const tmpPath = `${victimPath}.tmp`;
	assert.equal(existsSync(tmpPath), true, "expected the tmp payload after the failed rename");
	const tmpSession = JSON.parse(readFileSync(tmpPath, "utf8")) as WorkbenchChatSession;
	assert.equal(tmpSession.id, id);
	assert.equal(tmpSession.projectId, "workspace");
	assert.equal(tmpSession.title, "Session write probe");
	assert.equal(tmpSession.messages.length, 1);
	assert.equal(tmpSession.messages[0]?.role, "assistant");
	assert.equal(tmpSession.messages[0]?.content, "the atomic payload");

	// The destination was never partially written: it is still the directory.
	assert.equal(statSync(victimPath).isDirectory(), true);
	assert.equal(readFileSync(join(victimPath, "keep.txt"), "utf8"), "do not clobber");
});

test("a concurrent reader never observes torn session JSON while writes land", async () => {
	const root = makeWorkspace();
	const id = "torn-read-probe";
	const session = ensureWorkbenchChatSession({ workingDir: root }, {
		id,
		projectId: "workspace",
		title: "Torn read probe",
	});

	// An out-of-process reader parses the session file in a tight loop while the
	// server rewrites it. Atomic tmp+rename means every read resolves to one
	// complete file; a truncating in-place write would eventually be caught.
	const childScript = [
		"const fs = require('node:fs');",
		"const file = process.env.TORN_READ_SESSION_FILE;",
		"const sentinel = process.env.TORN_READ_SENTINEL_FILE;",
		"const deadline = Date.now() + 30000;",
		"let parses = 0;",
		"while (Date.now() < deadline) {",
		"  let text;",
		"  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {",
		"    if (error && error.code === 'ENOENT') continue;",
		"    process.exit(4);",
		"  }",
		"  try { JSON.parse(text); } catch { process.exit(2); }",
		"  parses += 1;",
		"  if (parses > 0 && fs.existsSync(sentinel)) process.exit(0);",
		"}",
		"process.exit(3);",
	].join("\n");
	const sentinel = join(root, "torn-read.sentinel");
	const child = spawn(process.execPath, ["-e", childScript], {
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			TORN_READ_SESSION_FILE: sessionPath(root, id),
			TORN_READ_SENTINEL_FILE: sentinel,
		},
	});
	// The reader samples concurrently; the writes below start immediately.
	const exitCode = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? -1));
	});

	// Rewrites grow from ~150 KB to a few MB so a non-atomic write would spend
	// a long, easily-sampled window with the file truncated mid-write.
	const chunk = "x".repeat(150_000);
	let current = session;
	for (let i = 0; i < 12; i++) {
		current = appendWorkbenchChatAssistantMessage({ workingDir: root }, current, `${chunk} turn ${i}`);
	}
	writeFileSync(sentinel, "done\n", "utf8");
	assert.equal(await exitCode, 0, "reader process must exit cleanly; exit 2 means a torn read was observed");
});

test("stream updates coalesce to one disk write per coalescing window", async () => {
	const root = makeWorkspace();
	const id = "coalesce-probe";
	const base = ensureWorkbenchChatSession({ workingDir: root }, {
		id,
		projectId: "workspace",
		title: "Coalesce probe",
	});
	const coalescer = createWorkbenchStreamWriteCoalescer(sessionPath(root, id));

	// Ten stream updates inside the coalescing window produce exactly one disk
	// write, and it reflects the first update.
	let session = base;
	for (let i = 0; i < 10; i++) {
		session = coalescer.write(withAssistantDelta(session, `delta-${i}`));
	}
	assert.equal(coalescer.writeCount, 1);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "delta-0");

	// Still inside the window: suppressed, but the returned session still moves.
	session = coalescer.write(withAssistantDelta(session, "delta-10"));
	assert.equal(coalescer.writeCount, 1);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "delta-0");

	// A tool-event boundary bypasses the window.
	session = coalescer.write(withAssistantDelta(session, "delta-11"), { toolEventChanged: true });
	assert.equal(coalescer.writeCount, 2);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "delta-11");

	// Once the window elapses, the next update persists again.
	await sleep(WORKBENCH_STREAM_WRITE_COALESCE_MS + 60);
	session = coalescer.write(withAssistantDelta(session, "delta-12"));
	assert.equal(coalescer.writeCount, 3);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "delta-12");

	// Turn end always flushes, and the flush opens a fresh window.
	const final = coalescer.flush(withAssistantDelta(session, "final"));
	assert.equal(coalescer.writeCount, 4);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "final");
	coalescer.write(withAssistantDelta(final, "after-flush"));
	assert.equal(coalescer.writeCount, 4);
	assert.equal(readDiskSession(root, id).messages.at(-1)?.content, "final");
});

test("stream writes fold steered messages in before any disk write", () => {
	const root = makeWorkspace();
	const id = "merge-guard-probe";
	const base = ensureWorkbenchChatSession({ workingDir: root }, {
		id,
		projectId: "workspace",
		title: "Merge guard probe",
	});
	const path = sessionPath(root, id);
	const coalescer = createWorkbenchStreamWriteCoalescer(path);

	// The in-memory stream session has an assistant update the disk lacks.
	let memory: WorkbenchChatSession = { ...base, messages: [...base.messages, assistantMessage("streamed so far")] };

	// A steered message lands on disk while the stream is running, the way
	// steerWorkbenchChatMessage writes it.
	const steered: WorkbenchChatMessage = {
		id: "steered-1",
		role: "user",
		content: "steer toward the brief",
		createdAt: isoNow(5_000),
		status: "complete",
		toolEvents: [],
	};
	writeFileSync(path, `${JSON.stringify({ ...base, messages: [...base.messages, steered] }, null, 2)}\n`, "utf8");

	// First stream update: the fresh window persists, and the merge guard must
	// fold the steered message in before that write lands.
	memory = coalescer.write(memory);
	assert.equal(coalescer.writeCount, 1);
	let disk = readDiskSession(root, id);
	assert.deepEqual(
		disk.messages.map((message) => message.id),
		["assistant-probe", "steered-1"],
	);
	assert.ok(memory.messages.some((message) => message.id === "steered-1"));

	// A second steered message arrives while the next update is inside the
	// coalescing window. The in-memory assistant content is also ahead of disk,
	// so a suppressed write is distinguishable from a performed one.
	const steeredTwo: WorkbenchChatMessage = {
		id: "steered-2",
		role: "user",
		content: "and also check the sources",
		createdAt: isoNow(6_000),
		status: "complete",
		toolEvents: [],
	};
	disk = readDiskSession(root, id);
	writeFileSync(path, `${JSON.stringify({ ...disk, messages: [...disk.messages, steeredTwo] }, null, 2)}\n`, "utf8");
	const diskBeforeSuppressedUpdate = readDiskSession(root, id);
	memory = {
		...memory,
		messages: memory.messages.map((message) =>
			message.role === "assistant" ? { ...message, content: "streamed further along" } : message
		),
	};

	memory = coalescer.write(memory);
	assert.equal(coalescer.writeCount, 1, "the update inside the window must not write");
	assert.ok(memory.messages.some((message) => message.id === "steered-2"), "merge guard must run even when the write is suppressed");
	assert.deepEqual(
		readDiskSession(root, id),
		diskBeforeSuppressedUpdate,
		"disk must stay untouched while the write is suppressed",
	);

	// Turn end: the flush persists the merged state, steered messages included.
	memory = coalescer.flush(memory);
	assert.equal(coalescer.writeCount, 2);
	disk = readDiskSession(root, id);
	assert.deepEqual(
		disk.messages.map((message) => message.id),
		["assistant-probe", "steered-1", "steered-2"],
	);
	assert.deepEqual(
		disk.messages.map((message) => message.id),
		memory.messages.map((message) => message.id),
	);
});

test("streamWorkbenchChatMessage keeps the SSE cadence and always flushes final state", async () => {
	const root = makeWorkspace();
	const id = "stream-flush-probe";
	const events: Array<{ type: string }> = [];
	const session = await streamWorkbenchChatMessage(
		{
			workingDir: root,
			executor: async () => ({
				content: "streamed answer",
				toolEvents: [{ id: "tool-1", label: "fixture executor", status: "complete" }],
			}),
		},
		{ id, projectId: "workspace", title: "Stream flush probe", message: "run the turn" },
		async (event) => {
			events.push(event);
		},
	);

	assert.equal(session.status, "complete");
	// The executor path still emits session -> delta -> tool -> done.
	assert.deepEqual(events.map((event) => event.type), ["session", "delta", "tool", "done"]);

	const disk = readDiskSession(root, id);
	assert.equal(disk.status, "complete");
	const assistant = disk.messages.find((message) => message.role === "assistant");
	assert.equal(assistant?.content, "streamed answer");
	assert.equal(assistant?.toolEvents[0]?.label, "fixture executor");
	assert.equal(existsSync(`${sessionPath(root, id)}.tmp`), false, "no tmp sidecar may survive a completed write");
});
