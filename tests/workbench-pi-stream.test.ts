import test from "node:test";
import assert from "node:assert/strict";

import {
	applyWorkbenchPiRunEvent,
	applyWorkbenchPiRunLine,
	createWorkbenchPiRunState,
	handlePiJsonLine,
	settleWorkbenchPiRunState,
	workbenchPiMessageStatus,
	type WorkbenchPiRunState,
} from "../src/workbench/chat-runtime.js";
import type { WorkbenchToolEvent } from "../src/workbench/chat.js";

test("workbench Pi RPC stream accepts Pi 0.84 delta-only message updates", async () => {
	const toolEvents = new Map();
	const updates: Array<{ contentDelta?: string; status?: string }> = [];
	for (const delta of ["partial ", "answer"]) {
		await handlePiJsonLine(JSON.stringify({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta,
			},
		}), toolEvents, (update) => {
			updates.push(update);
		});
	}

	assert.deepEqual(updates, [
		{ contentDelta: "partial ", status: "running", toolEvents: [] },
		{ contentDelta: "answer", status: "running", toolEvents: [] },
	]);
});

type CapturedUpdate = {
	content?: string;
	contentDelta?: string;
	status?: string;
	toolEvents?: Array<{ id: string; label: string; status: string }>;
};

type RunDriver = {
	state: WorkbenchPiRunState;
	updates: CapturedUpdate[];
	toolEvents: Map<string, WorkbenchToolEvent>;
	/** Run status observed after each input line was processed. */
	statusAfterEachLine: string[];
};

async function driveRunLines(lines: string[]): Promise<RunDriver> {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();
	const updates: CapturedUpdate[] = [];
	const statusAfterEachLine: string[] = [];
	for (const line of lines) {
		await applyWorkbenchPiRunLine(state, line, toolEvents, (update) => {
			updates.push(update as CapturedUpdate);
		});
		statusAfterEachLine.push(state.status);
	}
	return { state, updates, toolEvents, statusAfterEachLine };
}

function assistantMessage(text: string, stopReason: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason,
	};
}

function textDelta(delta: string): string {
	return JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	});
}

test("workbench maps assistant message stop reasons to stream statuses", () => {
	assert.equal(workbenchPiMessageStatus("message_end", "stop"), "complete");
	assert.equal(workbenchPiMessageStatus("message_end", "length"), "complete");
	assert.equal(workbenchPiMessageStatus("message_end", "toolUse"), "running");
	assert.equal(workbenchPiMessageStatus("message_end", "deferred"), "running");
	assert.equal(workbenchPiMessageStatus("message_end", undefined), "running");
	assert.equal(workbenchPiMessageStatus("message_update", "stop"), "running");
	assert.equal(workbenchPiMessageStatus("message_update", undefined), "running");
	assert.equal(workbenchPiMessageStatus("message_end", "aborted"), "stopped");
	assert.equal(workbenchPiMessageStatus("message_end", "error"), "error");
});

test("workbench run state keeps mid-turn toolUse message ends running", async () => {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();
	await applyWorkbenchPiRunLine(state, textDelta("Let me check."), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_end",
		message: assistantMessage("Let me check.", "toolUse"),
	}), toolEvents, () => undefined);

	assert.equal(state.status, "running");
	assert.equal(state.lastStopReason, "toolUse");
	assert.equal(state.content, "Let me check.");
});

test("workbench run settles only on agent_settled, not agent_end", async () => {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();
	await applyWorkbenchPiRunLine(state, textDelta("Done."), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_end",
		message: assistantMessage("Done.", "stop"),
	}), toolEvents, () => undefined);
	assert.equal(state.status, "running", "message_end stop must not settle the run");

	const settledFromAgentEnd = await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "agent_end",
		messages: [],
		willRetry: false,
	}), toolEvents, () => undefined);
	assert.equal(settledFromAgentEnd, false);
	assert.equal(state.status, "running", "agent_end must not settle the run");

	const settled = await applyWorkbenchPiRunLine(state, JSON.stringify({ type: "agent_settled" }), toolEvents, () => undefined);
	assert.equal(settled, true);
	assert.equal(state.status, "complete");
});

// Scout report section 4 ordering: text deltas, mid-turn message_end toolUse,
// a tool window, second-message deltas, message_end stop, agent_end, agent_settled.
test("workbench Pi turn with a tool window stays running until settled", async () => {
	const driver = await driveRunLines([
		JSON.stringify({ type: "agent_start" }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
		textDelta("Checking the file."),
		JSON.stringify({
			type: "message_end",
			message: {
				...assistantMessage("Checking the file.", "toolUse"),
				toolCalls: [{ id: "tool-1", name: "read", arguments: { path: "outputs/report.md" } }],
			},
		}),
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "outputs/report.md" },
		}),
		JSON.stringify({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [{ type: "text", text: "read output" }] },
		}),
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "read output" }] },
			isError: false,
		}),
		JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
		textDelta("The file says hi."),
		JSON.stringify({
			type: "message_end",
			message: assistantMessage("The file says hi.", "stop"),
		}),
		JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
		JSON.stringify({ type: "agent_settled" }),
	]);

	const { state, updates, toolEvents, statusAfterEachLine } = driver;

	// updates[0] is the text delta; updates[1] is the mid-turn message_end that
	// used to flip the message to "complete" before the tool call even ran.
	assert.equal(updates[0]?.status, "running");
	assert.equal(updates[1]?.content, "Checking the file.");
	assert.equal(updates[1]?.status, "running", "mid-turn toolUse message_end must keep the message running");

	// The run stays running through the whole tool window and only settles on
	// agent_settled: agent_end (and every mid-turn message_end) never resolves it.
	assert.deepEqual(statusAfterEachLine, [
		"running", // agent_start
		"running", // message_start
		"running", // text delta
		"running", // message_end toolUse (previously latched "complete" here)
		"running", // tool_execution_start
		"running", // tool_execution_update
		"running", // tool_execution_end
		"running", // message_start
		"running", // text delta
		"running", // message_end stop (previously settled the run early)
		"running", // agent_end (previously resolved the run here)
		"complete", // agent_settled
	]);

	// Tool events are recorded.
	const toolEnd = toolEvents.get("tool-1");
	assert.ok(toolEnd, "expected the read tool event");
	assert.equal(toolEnd.status, "complete");

	// The final message_end maps to complete but must not shrink the
	// accumulated transcript to only the newest message's text.
	const finalMessageEnd = updates.at(-1);
	assert.ok(finalMessageEnd);
	assert.equal(finalMessageEnd.status, "complete");
	assert.equal(finalMessageEnd.content, "Checking the file.The file says hi.");

	// The run settles at agent_settled with the derived final status.
	assert.equal(state.status, "complete");
	assert.equal(state.lastStopReason, "stop");
	assert.equal(state.content, "Checking the file.The file says hi.");
});

test("workbench Pi turn keeps running through queued continuations", async () => {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();
	const updates: CapturedUpdate[] = [];
	const drive = async (line: string) => {
		await applyWorkbenchPiRunLine(state, line, toolEvents, (update) => {
			updates.push(update as CapturedUpdate);
		});
	};

	await drive(JSON.stringify({ type: "agent_start" }));
	await drive(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
	await drive(textDelta("Working on it."));
	await drive(JSON.stringify({ type: "message_end", message: assistantMessage("Working on it.", "stop") }));
	await drive(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }));
	assert.equal(state.status, "running", "agent_end before a queued continuation must not settle");

	await drive(JSON.stringify({ type: "queue_update", steering: ["Also summarize"], followUp: [] }));
	assert.equal(state.status, "running");
	await drive(JSON.stringify({ type: "agent_start" }));
	await drive(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
	await drive(textDelta("Summary: done."));
	await drive(JSON.stringify({ type: "message_end", message: assistantMessage("Summary: done.", "stop") }));
	await drive(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }));
	assert.equal(state.status, "running", "the second agent_end still must not settle");

	const settled = await applyWorkbenchPiRunLine(state, JSON.stringify({ type: "agent_settled" }), toolEvents, () => undefined);
	assert.equal(settled, true);
	assert.equal(state.status, "complete");
	assert.equal(state.content, "Working on it.Summary: done.");

	const steerQueue = updates.filter((update) => update.toolEvents?.some((event) => event.label === "Pi message queue"));
	assert.ok(steerQueue.length >= 1, "expected the Pi message queue tool event");
});

test("workbench Pi turn aborted mid-message settles to stopped", async () => {
	const driver = await driveRunLines([
		JSON.stringify({ type: "agent_start" }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
		textDelta("Partial ans"),
		JSON.stringify({
			type: "message_end",
			message: assistantMessage("Partial ans", "aborted"),
		}),
		JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
		JSON.stringify({ type: "agent_settled" }),
	]);

	const { state, updates } = driver;
	assert.equal(updates[1]?.status, "stopped", "the aborted message reports stopped to the stream");
	assert.equal(state.status, "stopped");
	assert.equal(state.content, "Partial ans");
});

test("workbench Pi turn retried after a transient error settles to complete", async () => {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();
	const updates: CapturedUpdate[] = [];
	const drive = async (line: string) => {
		await applyWorkbenchPiRunLine(state, line, toolEvents, (update) => {
			updates.push(update as CapturedUpdate);
		});
	};

	await drive(JSON.stringify({ type: "agent_start" }));
	await drive(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
	await drive(textDelta("Partial "));
	await drive(JSON.stringify({
		type: "message_end",
		message: { ...assistantMessage("Partial ", "error"), errorMessage: "provider overloaded" },
	}));
	assert.equal(updates[1]?.status, "error", "the failed message still reports error to the stream");
	assert.equal(state.status, "running", "a mid-turn error must not latch the run status");

	await drive(JSON.stringify({ type: "agent_end", messages: [], willRetry: true }));
	assert.equal(state.status, "running", "a willRetry agent_end must not settle the run as error");

	await drive(JSON.stringify({ type: "auto_retry_start", attempt: 1 }));
	await drive(JSON.stringify({ type: "agent_start" }));
	await drive(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
	await drive(textDelta("Recovered answer."));
	await drive(JSON.stringify({
		type: "message_end",
		message: assistantMessage("Recovered answer.", "stop"),
	}));
	await drive(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }));
	assert.equal(state.status, "running");

	const settled = await applyWorkbenchPiRunLine(state, JSON.stringify({ type: "agent_settled" }), toolEvents, () => undefined);
	assert.equal(settled, true);
	assert.equal(state.status, "complete", "the successful retry decides the final status");
	assert.equal(state.content, "Partial Recovered answer.");
});

test("workbench run adopts non-streamed message snapshots without duplicating streamed text", async () => {
	const state = createWorkbenchPiRunState();
	const toolEvents = new Map<string, WorkbenchToolEvent>();

	// A message that never streamed deltas: its snapshot must be adopted once.
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_start",
		message: { role: "assistant", content: [] },
	}), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_end",
		message: assistantMessage("Full answer without deltas.", "stop"),
	}), toolEvents, () => undefined);
	assert.equal(state.content, "Full answer without deltas.");

	// Repeating the same snapshot must not duplicate the text.
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_start",
		message: { role: "assistant", content: [] },
	}), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_end",
		message: assistantMessage("Full answer without deltas.", "stop"),
	}), toolEvents, () => undefined);
	assert.equal(state.content, "Full answer without deltas.");

	// A snapshot covering streamed deltas extends the transcript by the tail only.
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_start",
		message: { role: "assistant", content: [] },
	}), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, textDelta("Stream"), toolEvents, () => undefined);
	await applyWorkbenchPiRunLine(state, JSON.stringify({
		type: "message_end",
		message: assistantMessage("Streamed tail.", "stop"),
	}), toolEvents, () => undefined);
	assert.equal(state.content, "Full answer without deltas.Streamed tail.");
});

test("workbench run event helper ignores non-message lifecycle events", () => {
	const state = createWorkbenchPiRunState();
	applyWorkbenchPiRunEvent(state, { type: "agent_start" });
	applyWorkbenchPiRunEvent(state, { type: "agent_end", messages: [] });
	applyWorkbenchPiRunEvent(state, { type: "turn_start" });
	applyWorkbenchPiRunEvent(state, { type: "message_start", message: { role: "user", content: "hi" } });
	applyWorkbenchPiRunEvent(state, { type: "message_end", message: { role: "toolResult", content: [] } });
	assert.equal(state.status, "running");
	assert.equal(state.content, "");
	assert.equal(state.messageContent, "");
	assert.equal(state.lastStopReason, undefined);
});

test("workbench settle derives stopped and error finals from the last stop reason", () => {
	const stopped = createWorkbenchPiRunState();
	stopped.lastStopReason = "aborted";
	assert.equal(settleWorkbenchPiRunState(stopped), "stopped");

	const failed = createWorkbenchPiRunState();
	failed.lastStopReason = "error";
	assert.equal(settleWorkbenchPiRunState(failed), "error");

	const complete = createWorkbenchPiRunState();
	complete.lastStopReason = "stop";
	assert.equal(settleWorkbenchPiRunState(complete), "complete");

	const silent = createWorkbenchPiRunState();
	assert.equal(settleWorkbenchPiRunState(silent), "complete");
});
