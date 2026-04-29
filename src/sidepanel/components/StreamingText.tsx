import { useEffect, useRef } from "preact/hooks";
import { marked, Renderer } from "marked";

interface StreamingTextProps {
  chunks: string;
  isStreaming: boolean;
}

// Custom renderer: strip the <p> wrapper inside <li> items.
// marked adds these when lists have blank lines between items ("loose lists"),
// which causes massive double-spacing in the sidepanel.
const renderer = new Renderer();
renderer.listitem = function ({ tokens, task, checked }) {
  // Render child tokens but strip the outer <p>...</p> wrapper
  const body = this.parser!.parseInline(tokens).replace(/^<p>(.*?)<\/p>\n?$/s, "$1");
  if (task) {
    const checkbox = `<input type="checkbox"${checked ? " checked" : ""} disabled /> `;
    return `<li class="task-list-item">${checkbox}${body}</li>\n`;
  }
  return `<li>${body}</li>\n`;
};

marked.use({
  renderer,
  breaks: true,
  gfm: true,
});

/**
 * Renders accumulated markdown text with a blinking cursor while streaming.
 * Uses marked to parse markdown so headings, bold, lists and links render properly.
 * Custom list-item renderer removes the extra <p> wrapping that causes blank-line spacing.
 */
export function StreamingText({ chunks, isStreaming }: StreamingTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chunks]);

  if (!chunks && !isStreaming) return null;

  // Parse markdown to HTML; fall back to plain text if marked throws
  let html = "";
  try {
    html = marked.parse(chunks) as string;
  } catch {
    html = chunks;
  }

  return (
    <div class="streaming" ref={containerRef}>
      <div
        class="streaming__text md-body"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: content comes from local LLM, not user or external input
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {isStreaming && <span class="streaming__cursor" />}
    </div>
  );
}
