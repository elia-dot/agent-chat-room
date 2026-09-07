import { useState } from 'react';

import type { SocketDiagnostics } from '../api/socket.js';

export interface DisconnectedPanelProps {
  diagnostics: SocketDiagnostics;
  /** The app's clock, so the retry countdown ticks without a second timer in here. */
  now: number;
  /** The room the frozen transcript belongs to, so the panel can name what may still be running. */
  context?: string;
  onRetry: () => void;
}

/**
 * The honest failure state.
 *
 * This used to be nothing at all: the socket dropped, the room area went blank, and the app
 * looked idle. The design's rule is that the frozen transcript stays visible behind this
 * panel, because the last thing you read is still true, and the panel says exactly three
 * things – what stopped, how stale the view is, and what to type to fix it.
 *
 * Every line here is something the browser actually observed. There is no green tick for
 * anything this side of the socket cannot see.
 */
export function DisconnectedPanel({
  diagnostics,
  now,
  context,
  onRetry,
}: DisconnectedPanelProps): React.ReactElement {
  const countdown =
    diagnostics.nextRetryAt === null
      ? null
      : Math.max(0, Math.ceil((diagnostics.nextRetryAt - now) / 1000));
  const [copied, setCopied] = useState(false);

  const stale = diagnostics.lastFrameAt
    ? new Date(diagnostics.lastFrameAt).toLocaleTimeString()
    : 'never';

  const report = [
    `state       ${diagnostics.state}`,
    `socket      ${diagnostics.url}`,
    `attempts    ${diagnostics.attempt}`,
    `last frame  ${stale}`,
    `user agent  ${navigator.userAgent}`,
  ].join('\n');

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
      <div
        role="alert"
        className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-lg border border-error-line bg-ground shadow-2xl"
      >
        <div className="border-b border-error-line bg-error-bg px-4 py-3">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-error">CONNECTION LOST</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            The acr server stopped responding. What you can see behind this panel is the last state
            received at {stale}. It is not live{context ? `, and ${context}` : ''}.
          </p>
        </div>

        <div className="px-4 py-3">
          <h3 className="font-mono text-[10px] tracking-[0.12em] text-ink-faint">DIAGNOSIS</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
            <dt className="text-ink-faint">socket</dt>
            <dd className="break-all text-ink-soft">{diagnostics.url}</dd>
            <dt className="text-ink-faint">state</dt>
            <dd className="text-ink-soft">{diagnostics.state}</dd>
            <dt className="text-ink-faint">last frame</dt>
            <dd className="text-ink-soft">{stale}</dd>
            <dt className="text-ink-faint">retry</dt>
            <dd className="text-ink-soft">
              {diagnostics.attempt > 0 ? `attempt ${diagnostics.attempt}` : 'not yet retried'}
              {countdown !== null ? ` · next in ${countdown}s` : ''}
            </dd>
          </dl>

          <pre className="mt-3 overflow-x-auto rounded border border-line bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink-soft">
            {'$ acr doctor\n'}
            <span className="text-ink-faint">
              {'→ if the server is not running, start it with\n'}
            </span>
            {'$ acr serve'}
          </pre>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
              nothing you type will be delivered until this reconnects
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(report).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-ink-dim hover:border-line-strong hover:text-ink"
            >
              {copied ? 'copied' : 'copy diagnostics'}
            </button>
            <button
              type="button"
              onClick={onRetry}
              className="rounded bg-ink px-3 py-1 font-mono text-[11px] text-ground"
            >
              retry now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
