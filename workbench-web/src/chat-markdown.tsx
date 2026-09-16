import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type ChatMarkdownProps = {
	/** Owning message id; combined with `content` it drives the per-message memo. */
	messageId: string;
	content: string;
};

/**
 * Overrides that harden rendered message markdown:
 * - links open in a new tab with `rel="noopener noreferrer"` so untrusted
 *   targets cannot get a window reference back to the workbench;
 * - images with a stripped URL (react-markdown neutralizes `javascript:` and
 *   other unsafe schemes to an empty string) are not rendered at all, which
 *   avoids the browser re-download warning for `<img src="">`.
 * Raw HTML is never rendered: react-markdown escapes html nodes to plain text
 * by default, so `<script>` tags in message content stay inert.
 */
const markdownComponents: Components = {
	a: ({ children, href, title }) => (
		<a href={href} title={title} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	),
	img: ({ alt, src, title }) => (src ? <img src={src} alt={alt} title={title} loading="lazy" /> : null),
};

function ChatMarkdownBase({ content }: ChatMarkdownProps) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
			{content}
		</ReactMarkdown>
	);
}

export function chatMarkdownPropsAreEqual(prev: ChatMarkdownProps, next: ChatMarkdownProps): boolean {
	return prev.messageId === next.messageId && prev.content === next.content;
}

/**
 * Message markdown renderer. Memoized per message id so streaming updates only
 * re-parse the message whose content actually changed, and long transcripts do
 * not re-render unaffected messages.
 */
export const ChatMarkdown = memo(ChatMarkdownBase, chatMarkdownPropsAreEqual);
