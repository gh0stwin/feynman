import assert from "node:assert/strict";
import test from "node:test";

import {
	extractWorkbenchSessionImages,
	imagesForUserMessage,
	workbenchSessionImageUrl,
} from "../workbench-web/src/session-images.js";

function timelineEntries() {
	return [
		{
			id: "si0",
			kind: "session_info",
		},
		{
			// User image input: image block first, text block second.
			id: "u1",
			kind: "message",
			role: "user",
			blocks: [
				{ type: "image", contentIndex: 0, mimeType: "image/png", sizeBytes: 92, dataOmitted: true },
				{ type: "text", contentIndex: 1, text: "What is in this image?" },
			],
		},
		{
			id: "a2",
			kind: "message",
			role: "assistant",
			blocks: [{ type: "text", contentIndex: 0, text: "Looking." }],
		},
		{
			// Imageless user message: still occupies a user slot for position mapping.
			id: "u3",
			kind: "message",
			role: "user",
			blocks: [{ type: "text", contentIndex: 0, text: "Another question" }],
		},
		{
			// Tool image output: text block first, image block second.
			id: "t3",
			kind: "tool_result",
			role: "toolResult",
			toolCallId: "tc-img-1",
			blocks: [
				{ type: "text", contentIndex: 0, text: "Captured." },
				{ type: "image", contentIndex: 1, mimeType: "image/jpeg", dataOmitted: true },
			],
		},
	];
}

test("extractWorkbenchSessionImages indexes user image inputs and tool image outputs", () => {
	const index = extractWorkbenchSessionImages(timelineEntries());
	assert.deepEqual(index.userImages, [
		[{ entryId: "u1", blockIndex: 0, mimeType: "image/png", sizeBytes: 92 }],
		[],
	]);
	assert.deepEqual(index.imagesByToolCallId, {
		"tc-img-1": [{ entryId: "t3", blockIndex: 1, mimeType: "image/jpeg" }],
	});
});

test("extractWorkbenchSessionImages ignores non-image blocks and malformed entries", () => {
	assert.deepEqual(extractWorkbenchSessionImages([]), { userImages: [], imagesByToolCallId: {} });
	assert.deepEqual(extractWorkbenchSessionImages(undefined), { userImages: [], imagesByToolCallId: {} });
	assert.deepEqual(extractWorkbenchSessionImages("nope"), { userImages: [], imagesByToolCallId: {} });
	const index = extractWorkbenchSessionImages([
		{
			id: "m1",
			kind: "message",
			role: "user",
			blocks: [
				{ type: "text", contentIndex: 0, text: "only text" },
				{ type: "image", contentIndex: -1, dataOmitted: true },
				{ type: "image", contentIndex: 1.5, dataOmitted: true },
				{ type: "image", contentIndex: 3 },
			],
		},
		{ blocks: [{ type: "image", contentIndex: 0, dataOmitted: true }] },
		{
			id: "t9",
			kind: "tool_result",
			// No toolCallId: image outputs cannot be attached to a tool event.
			blocks: [{ type: "image", contentIndex: 0, dataOmitted: true }],
		},
	]);
	// The imageless user message still occupies a slot so position-mapping stays aligned.
	assert.deepEqual(index, { userImages: [[]], imagesByToolCallId: {} });
});

test("imagesForUserMessage zips user chat messages with user image entries positionally", () => {
	const index = extractWorkbenchSessionImages(timelineEntries());
	const messages = [
		{ role: "user" },
		{ role: "assistant" },
		{ role: "user" },
	];
	assert.deepEqual(imagesForUserMessage(index.userImages, messages, 0), [
		{ entryId: "u1", blockIndex: 0, mimeType: "image/png", sizeBytes: 92 },
	]);
	assert.deepEqual(imagesForUserMessage(index.userImages, messages, 1), []);
	assert.deepEqual(imagesForUserMessage(index.userImages, messages, 2), []);

	// If the timeline has more image slots than user messages, it does not line
	// up with the transcript: do not guess.
	assert.deepEqual(imagesForUserMessage(index.userImages, [{ role: "user" }], 0), []);
	assert.deepEqual(imagesForUserMessage([], messages, 0), []);
	assert.deepEqual(imagesForUserMessage(index.userImages, [], 0), []);
});

test("imagesForUserMessage aligns to the covered suffix when the window is partial", () => {
	// Timeline window covers only the newest 2 of 3 user messages (pagination
	// cap); the oldest out-of-window user message must not blank the session.
	const userImages = [
		[{ entryId: "u2", blockIndex: 0 }],
		[],
	];
	const messages = [{ role: "user" }, { role: "user" }, { role: "user" }];
	assert.deepEqual(imagesForUserMessage(userImages, messages, 0), []);
	assert.deepEqual(imagesForUserMessage(userImages, messages, 1), [{ entryId: "u2", blockIndex: 0 }]);
	assert.deepEqual(imagesForUserMessage(userImages, messages, 2), []);
});

test("imagesForUserMessage returns no images when image slots outnumber user messages", () => {
	const messages = [{ role: "user" }, { role: "user" }];
	const userImages = [[{ entryId: "u1", blockIndex: 0 }], [], [{ entryId: "u3", blockIndex: 0 }]];
	assert.deepEqual(imagesForUserMessage(userImages, messages, 0), []);
	assert.deepEqual(imagesForUserMessage(userImages, messages, 1), []);
});

test("workbenchSessionImageUrl builds the image endpoint src with block and optional token", () => {
	assert.equal(
		workbenchSessionImageUrl("session-1", { entryId: "u1", blockIndex: 0 }),
		"/api/chat/session/session-1/entry/u1/image?block=0",
	);
	assert.equal(
		workbenchSessionImageUrl("session-1", { entryId: "t3", blockIndex: 1 }, "tok"),
		"/api/chat/session/session-1/entry/t3/image?block=1&token=tok",
	);
	assert.equal(
		workbenchSessionImageUrl("a b/c", { entryId: "e#1", blockIndex: 12 }),
		"/api/chat/session/a%20b%2Fc/entry/e%231/image?block=12",
	);
});
