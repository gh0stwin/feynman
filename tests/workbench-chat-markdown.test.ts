import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatMarkdown, chatMarkdownPropsAreEqual } from "../workbench-web/src/chat-markdown.js";

function renderMarkdown(content: string): string {
	return renderToStaticMarkup(createElement(ChatMarkdown, { messageId: "message-1", content }));
}

test("chat markdown renders message content as paragraphs, emphasis, lists, links, and code", () => {
	const html = renderMarkdown([
		"# Result summary",
		"",
		"The **pipeline** is *verified* and the `parseLaTeX` helper is safe.",
		"",
		"- first bullet",
		"- second bullet",
		"",
		"1. step one",
		"2. step two",
		"",
		"See the [paper index](https://example.test/papers) for detail.",
		"",
		"```python",
		"print(\"hello\")",
		"```",
	].join("\n"));

	assert.match(html, /<h1>Result summary<\/h1>/);
	assert.match(html, /<p>The <strong>pipeline<\/strong> is <em>verified<\/em> and the <code>parseLaTeX<\/code> helper is safe\.<\/p>/);
	assert.match(html, /<ul>/);
	assert.match(html, /<li>first bullet<\/li>/);
	assert.match(html, /<ol>/);
	assert.match(html, /<li>step one<\/li>/);
	assert.match(
		html,
		/<a href="https:\/\/example\.test\/papers" target="_blank" rel="noopener noreferrer">paper index<\/a>/,
	);
	assert.match(html, /<pre><code class="language-python">print\(&quot;hello&quot;\)/);
});

test("chat markdown renders GFM tables and task lists", () => {
	const html = renderMarkdown([
		"| claim | status |",
		"| --- | --- |",
		"| result reproduced | pass |",
		"",
		"- [x] cited source",
		"- [ ] rerun check",
	].join("\n"));

	assert.match(html, /<table>/);
	assert.match(html, /<th>claim<\/th>/);
	assert.match(html, /<td>result reproduced<\/td>/);
	assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
	assert.match(html, /cited source/);
});

test("chat markdown escapes hostile untrusted content instead of rendering it", () => {
	const html = renderMarkdown("Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>");

	assert.equal(html.includes("<script"), false);
	assert.equal(html.includes("<img"), false);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /alert\(1\)/);
});

test("chat markdown strips unsafe link and image URLs", () => {
	const html = renderMarkdown("[click](javascript:alert(1)) ![pixel](javascript:alert(2))");

	assert.equal(html.includes("javascript:"), false);
	assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">click<\/a>/);
	assert.equal(html.includes("<img"), false);
});

test("chat markdown memoizes per message id and content", () => {
	const props = { messageId: "assistant-1", content: "hello" };
	assert.equal(chatMarkdownPropsAreEqual(props, { messageId: "assistant-1", content: "hello" }), true);
	assert.equal(chatMarkdownPropsAreEqual(props, { messageId: "assistant-1", content: "changed" }), false);
	assert.equal(chatMarkdownPropsAreEqual(props, { messageId: "assistant-2", content: "hello" }), false);
	assert.equal(
		(ChatMarkdown as { $$typeof?: symbol }).$$typeof,
		Symbol.for("react.memo"),
		"ChatMarkdown must be a React.memo component",
	);
});

test("chat markdown renders empty and streaming-partial content without crashing", () => {
	assert.equal(renderMarkdown(""), "");
	assert.match(renderMarkdown("# Partial"), /<h1>Partial<\/h1>/);
});
