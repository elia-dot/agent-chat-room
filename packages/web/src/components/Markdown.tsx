import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
  'vscode:',
  'cursor:',
  'windsurf:',
]);

/**
 * Allow safe web and IDE deep-link protocols while preventing script execution (XSS).
 */
export function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return trimmed;
  }
  const protocol = trimmed.slice(0, colonIndex + 1).toLowerCase();
  if (SAFE_PROTOCOLS.has(protocol)) {
    return trimmed;
  }
  return '';
}

/**
 * Convert file:line references into markdown links with IDE deep-links without mutating
 * fenced code blocks or arbitrary inline code spans.
 */
function linkifyCitations(text: string, basePath?: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('```')) return part;
      if (part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1).trim();
        const m = /^((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+):(\d+)$/.exec(inner);
        if (m) {
          const file = m[1]!;
          const line = m[2]!;
          const fullPath = basePath
            ? `${basePath.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`
            : file;
          const absPathWithSlash = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
          return `[\`${file}:${line}\`](vscode://file${absPathWithSlash}:${line})`;
        }
        return part;
      }
      return part.replace(
        /(?<![\w/`])((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+):(\d+)(?![\w/`])/g,
        (_match: string, file: string, line: string) => {
          const fullPath = basePath
            ? `${basePath.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`
            : file;
          const absPathWithSlash = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
          return `[\`${file}:${line}\`](vscode://file${absPathWithSlash}:${line})`;
        },
      );
    })
    .join('');
}

/**
 * An agent's answer is markdown, so it is rendered as markdown with sanitized links.
 */
export function Markdown({
  text,
  basePath,
}: {
  text: string;
  basePath?: string;
}): React.ReactElement {
  const processed = linkifyCitations(text, basePath);
  return (
    <div className="acr-md text-sm break-words whitespace-normal">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrlTransform}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}
