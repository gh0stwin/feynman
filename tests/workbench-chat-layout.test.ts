import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../workbench-web/src/styles.css", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../workbench-web/src/main.tsx", import.meta.url), "utf8");

/** Extract the body of the first top-level CSS rule whose selector list includes `selector`. */
function cssRuleBody(stylesSource: string, selector: string): string | null {
	const opener = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
	const match = stylesSource.match(opener);
	if (!match) return null;
	const start = (match.index ?? 0) + match[0].length;
	let depth = 1;
	let end = start;
	while (end < stylesSource.length && depth > 0) {
		const char = stylesSource[end];
		if (char === "{") depth += 1;
		if (char === "}") depth -= 1;
		end += 1;
	}
	return stylesSource.slice(start, end - 1);
}

function declaration(block: string, property: string): string | null {
	const match = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m"));
	return match?.[1]?.trim() ?? null;
}

test("conversation grid pins every pane to its designed row", () => {
	const conversation = cssRuleBody(styles, ".conversation");
	assert.ok(conversation, "expected a .conversation rule");
	assert.equal(
		declaration(conversation, "grid-template-rows"),
		"auto auto auto minmax(0, 1fr) auto",
		".conversation must keep the 5-row contract: topbar, tab strip, context strip, scrolling pane, composer",
	);

	const expectedRows: Array<[string, string]> = [
		[".topbar", "1"],
		[".workspace-tab-strip", "2"],
		[".context-strip", "3"],
		[".transcript", "4"],
		[".center-files-panel", "4"],
		[".composer", "5"],
	];
	for (const [selector, row] of expectedRows) {
		const block = cssRuleBody(styles, selector);
		assert.ok(block, `expected a ${selector} rule`);
		assert.equal(
			declaration(block, "grid-row"),
			row,
			`${selector} must pin grid-row: ${row}; unpinned children shift rows when a sibling is display:none`,
		);
	}
});

test("transcript scrolls inside its row and ends above the composer", () => {
	const transcript = cssRuleBody(styles, ".transcript");
	assert.ok(transcript, "expected a .transcript rule");
	assert.equal(declaration(transcript, "min-height"), "0", ".transcript must be shrinkable inside the 1fr row");
	assert.match(transcript, /overflow:\s*hidden\s+auto/, ".transcript must scroll internally (overflow auto)");

	const composer = cssRuleBody(styles, ".composer");
	assert.ok(composer, "expected a .composer rule");
	const position = declaration(composer, "position");
	assert.ok(position === null || position === "static", ".composer must stay in grid flow, not float over messages");

	const transcriptRow = declaration(transcript, "grid-row");
	const composerRow = declaration(composer, "grid-row");
	assert.equal(transcriptRow, "4", ".transcript owns the flexible row");
	assert.equal(composerRow, "5", ".composer owns the final auto row below the transcript");
});

test("mobile transcript no longer reserves floating-composer clearance", () => {
	const mobileTranscript = styles.match(/\n\t\.transcript\s*\{[^}]*\}/);
	assert.ok(mobileTranscript, "expected the small-viewport .transcript rule");
	assert.doesNotMatch(
		mobileTranscript[0],
		/\d+vh\s*;/,
		"the ≤760px transcript must not pad by viewport height for a composer that no longer floats",
	);
});

test("chat transcript and composer render as siblings in the conversation grid", () => {
	assert.match(mainSource, /<section className="transcript" aria-label="Chat transcript">/);
	assert.match(mainSource, /<form className="composer" onSubmit=\{sendMessage\}>/);
	const conversationStart = mainSource.indexOf('<main className="conversation">');
	const transcriptAt = mainSource.indexOf('<section className="transcript" aria-label="Chat transcript">');
	const composerAt = mainSource.indexOf('<form className="composer" onSubmit={sendMessage}>');
	const conversationEnd = mainSource.indexOf("</main>", conversationStart);
	assert.ok(conversationStart >= 0 && transcriptAt > conversationStart && composerAt > transcriptAt && composerAt < conversationEnd);
});
