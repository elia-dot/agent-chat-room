import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { AgentAdapter, ParsedVerdict, TurnEvent, TurnResult } from '@agent-chat-room/core';
import {
  buildTurnPrompt,
  getAdapter,
  git,
  parseVerdict,
  roleInstructions,
} from '@agent-chat-room/core';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';

export interface RunOptions {
  task: string;
  cwd: string;
  /** Runtime ids. First is the worker, second is the reviewer. */
  agents: string[];
  title?: string;
  modelWorker?: string;
  modelReviewer?: string;
  timeoutMs: number;
  allowDirty?: boolean;
  renderer?: Renderer;
}

export interface RunSummary {
  ok: boolean;
  exitCode: ExitCode;
  worker: { runtime: string; text: string; sessionId?: string; error?: string };
  reviewer?: { runtime: string; text: string; sessionId?: string; error?: string };
  verdict?: ParsedVerdict;
  changedFiles: string[];
  base?: string;
  branch: string;
}

/**
 * The M0 loop: one worker turn, then one reviewer turn, then a parsed verdict.
 *
 * There is deliberately no round loop, no state machine and no store here – those are M1.
 * What this proves is the thing the whole project rests on: that two different vendor CLIs
 * can be driven headlessly against the same repo, that the worker's diff reaches the
 * reviewer, and that the review comes back as structured data rather than vibes.
 */
export async function run(opts: RunOptions): Promise<RunSummary> {
  const r = opts.renderer ?? new Renderer();

  const workerId = opts.agents[0];
  const reviewerId = opts.agents[1];
  if (!workerId || !reviewerId) {
    throw new UsageError('--agents needs two runtimes, e.g. --agents claude,codex');
  }
  const worker = requireAdapter(workerId);
  const reviewer = requireAdapter(reviewerId);

  const root = (await git.repoRoot(opts.cwd)) ?? opts.cwd;
  const branch = await git.currentBranch(root);
  const base = await git.headSha(root);
  const title = opts.title ?? deriveTitle(opts.task, root);

  // M0 has no worktree (that is M1), so the worker edits the checkout you are standing in.
  // Refusing to start on a dirty tree is what keeps a room's diff attributable to the room.
  if (!opts.allowDirty && (await git.isDirty(root))) {
    throw new UsageError(
      `${root} has uncommitted changes. Commit or stash them, or pass --allow-dirty to run anyway.`,
    );
  }

  r.info(`room "${title}"`);
  r.info(`repo ${root} on ${branch}${base ? ` at ${base.slice(0, 8)}` : ''}`);
  r.info(`worker ${worker.id} · reviewer ${reviewer.id}`);

  // --- round 1, worker -----------------------------------------------------
  r.header(worker.id, 'worker', 1);
  const workerPrompt = buildTurnPrompt({
    runtime: worker.id,
    role: 'worker',
    title,
    round: 1,
    cwd: root,
    branch,
    task: opts.task,
  });
  const workerResult = await runOneTurn(worker, r, {
    cwd: root,
    prompt: workerPrompt,
    permission: 'edits',
    model: opts.modelWorker,
    systemAppend: roleInstructions('worker'),
    timeoutMs: opts.timeoutMs,
    turnId: randomUUID(),
  });

  const changed = await git.changedFiles(root, base);
  const summary: RunSummary = {
    ok: false,
    exitCode: EXIT.internalError,
    worker: {
      runtime: worker.id,
      text: workerResult.text,
      sessionId: workerResult.sessionId,
      error: workerResult.error,
    },
    changedFiles: changed,
    base,
    branch,
  };

  if (!workerResult.ok) {
    r.error(`worker turn failed: ${workerResult.error ?? 'unknown error'}`);
    return summary;
  }

  if (changed.length === 0) {
    r.info('  (no files changed)');
  } else {
    r.info(`  changed: ${changed.join(', ')}`);
  }

  // --- round 1, reviewer ---------------------------------------------------
  const diffStat = await git.diffStat(root, base);
  const diff = await git.diffSince(root, base);

  r.header(reviewer.id, 'reviewer', 1);
  const reviewerPrompt = buildTurnPrompt({
    runtime: reviewer.id,
    role: 'reviewer',
    title,
    round: 1,
    cwd: root,
    branch,
    task: opts.task,
    newMessages: [
      { author: worker.id, role: 'worker', round: 1, text: workerResult.text || '(no summary)' },
    ],
    diffStat,
    diff,
    diffCommand: base ? `git diff ${base}` : 'git diff HEAD',
  });
  const reviewerResult = await runOneTurn(reviewer, r, {
    cwd: root,
    prompt: reviewerPrompt,
    permission: 'read-only',
    model: opts.modelReviewer,
    systemAppend: roleInstructions('reviewer'),
    timeoutMs: opts.timeoutMs,
    turnId: randomUUID(),
  });

  summary.reviewer = {
    runtime: reviewer.id,
    text: reviewerResult.text,
    sessionId: reviewerResult.sessionId,
    error: reviewerResult.error,
  };

  if (!reviewerResult.ok) {
    r.error(`reviewer turn failed: ${reviewerResult.error ?? 'unknown error'}`);
    return summary;
  }

  const verdict = parseVerdict(reviewerResult.text);
  summary.verdict = verdict;
  r.verdict(verdict);

  if (!verdict.ok) {
    // Never guess an approval. Show the tail of what the reviewer actually said so the
    // human can see whether it was a formatting slip or a real refusal.
    const tail = reviewerResult.text.trim().split('\n').slice(-8).join('\n');
    if (tail) {
      r.line();
      r.info('  last lines of the review:');
      for (const line of tail.split('\n')) r.info(`  | ${line}`);
    }
    summary.exitCode = EXIT.notApproved;
    return summary;
  }

  summary.ok = verdict.verdict.decision === 'approve';
  summary.exitCode = summary.ok ? EXIT.ok : EXIT.notApproved;
  return summary;
}

async function runOneTurn(
  adapter: AgentAdapter,
  r: Renderer,
  req: Parameters<AgentAdapter['run']>[0],
): Promise<TurnResult> {
  const sink = (ev: TurnEvent): void => r.event(ev);
  const handle = adapter.run(req, sink);

  const onSignal = (): void => handle.cancel('interrupted');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await handle.done;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function requireAdapter(id: string): AgentAdapter {
  const adapter = getAdapter(id);
  if (!adapter)
    throw new UsageError(
      `unknown runtime "${id}". Run \`acr doctor\` to see what acr knows about.`,
    );
  return adapter;
}

function deriveTitle(task: string, root: string): string {
  const firstLine = task.trim().split('\n')[0]?.trim() ?? '';
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  return short || `task in ${basename(root)}`;
}

export class UsageError extends Error {}
