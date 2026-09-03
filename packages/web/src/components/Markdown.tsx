import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * An agent's answer is markdown, so it is rendered as markdown.
 *
 * No syntax highlighting: a highlighter is bigger than everything else in this app put
 * together, and PLAN.md's M2 line does not ask for one. A plain `<pre>` with a monospace
 * font is what a code block gets.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="acr-md text-sm break-words whitespace-normal">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
