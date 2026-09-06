import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentBranchNamer,
  buildBranchNamePrompt,
  cleanBranchSuggestion,
  condenseSlug,
} from '../src/branchName.js';
import type { AgentAdapter, TurnRequest, TurnResult } from '../src/types.js';

/** The task that produced the report: a paragraph, no title, opening with filler. */
const TASK =
  'right now the name of the branch created in build room is the entire task text, ' +
  "it's too long, it should be either the title (if provided), or that the agent " +
  'should summarize the task to simple one line branch name';

describe('condenseSlug', () => {
  it('condenses a paragraph into a few significant words', () => {
    const slug = condenseSlug(TASK);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
    expect(slug.split('-').length).toBeLessThanOrEqual(5);
    // The filler the task opens with is gone, and what is left describes the change.
    expect(slug.startsWith('right-now')).toBe(false);
    expect(slug).toContain('branch');
  });

  it('keeps a short task as it is', () => {
    expect(condenseSlug('Fix the flaky login test')).toBe('fix-flaky-login-test');
  });

  it('falls back rather than returning nothing', () => {
    expect(condenseSlug('')).toBe('room');
    expect(condenseSlug('   ')).toBe('room');
    // Everything is filler: better a slug made of filler than an empty branch name.
    expect(condenseSlug('please can you')).toBe('can-you');
  });

  it('survives a task with no latin characters at all', () => {
    expect(condenseSlug('🙃🙃🙃')).toBe('room');
    expect(condenseSlug('תקן את הבדיקה', 'task')).toBe('task');
  });
});

describe('buildBranchNamePrompt', () => {
  it('asks for a bare kebab-case name and includes the task', () => {
    const prompt = buildBranchNamePrompt(`  ${TASK}  `);
    expect(prompt).toContain('kebab-case');
    expect(prompt).toContain('no `acr/` prefix');
    expect(prompt).toContain(TASK);
  });
});

describe('cleanBranchSuggestion', () => {
  it('takes a bare slug', () => {
    expect(cleanBranchSuggestion('fix-flaky-login')).toBe('fix-flaky-login');
  });

  it('strips the noise a runtime wraps its answer in', () => {
    expect(cleanBranchSuggestion('`fix-flaky-login`')).toBe('fix-flaky-login');
    expect(cleanBranchSuggestion('"Fix Flaky Login"')).toBe('fix-flaky-login');
    expect(cleanBranchSuggestion('acr/fix-login')).toBe('fix-login');
    expect(cleanBranchSuggestion('branch: fix-login')).toBe('fix-login');
  });

  it('finds the name under trailing prose', () => {
    expect(cleanBranchSuggestion('shorten-room-branch-name\n\nThis names the change.')).toBe(
      'shorten-room-branch-name',
    );
  });

  it('rejects an answer that is not a name', () => {
    expect(
      cleanBranchSuggestion(
        'Sure, I can help with that. A good branch name here would describe the fix.',
      ),
    ).toBeNull();
    expect(cleanBranchSuggestion('')).toBeNull();
    expect(cleanBranchSuggestion('   \n\n  ')).toBeNull();
    expect(cleanBranchSuggestion('🙃')).toBeNull();
  });

  it('never returns something git would refuse', () => {
    const junk = ['  ../../Fix THE thing  ', '$(rm -rf ~)', 'feature/Fix Login', 'x'.repeat(120)];
    for (const raw of junk) {
      const slug = cleanBranchSuggestion(raw);
      expect(slug === null || /^[a-z0-9][a-z0-9-]*$/.test(slug)).toBe(true);
      expect(slug?.length ?? 0).toBeLessThanOrEqual(40);
    }
  });
});

// --- agentBranchNamer ------------------------------------------------------

/** An adapter that answers every turn with `reply`, or hangs when `hang` is set. */
function fakeAdapter(opts: {
  reply?: string;
  ok?: boolean;
  hang?: boolean;
  onRun?: (req: TurnRequest) => void;
  onCancel?: () => void;
}): AgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { resume: false, readOnly: true, structuredOutput: false },
    detect: () => Promise.resolve({ installed: true, minVersionOk: true }),
    run(req) {
      opts.onRun?.(req);
      let settle!: (result: TurnResult) => void;
      const done = new Promise<TurnResult>((resolve) => {
        settle = resolve;
        if (!opts.hang) {
          setImmediate(() => resolve({ ok: opts.ok ?? true, text: opts.reply ?? '', exitCode: 0 }));
        }
      });
      return {
        turnId: 'fake-turn',
        cancel() {
          opts.onCancel?.();
          settle({ ok: false, text: '', exitCode: null, cancelled: true });
        },
        done,
      };
    },
  };
}

const ctx = (adapter: AgentAdapter, model?: string) => ({
  task: TASK,
  title: 'right now the name of the branch',
  repoRoot: '/repo',
  adapter,
  ...(model ? { model } : {}),
});

afterEach(() => {
  delete process.env.ACR_NO_AUTO_BRANCH_NAME;
  vi.useRealTimers();
});

describe('agentBranchNamer', () => {
  it('runs one read-only turn on the worker model and cleans the answer', async () => {
    const seen: TurnRequest[] = [];
    const adapter = fakeAdapter({
      reply: 'Here you go:\n\n`shorten-room-branch-name`\n',
      onRun: (req) => seen.push(req),
    });

    expect(await agentBranchNamer(ctx(adapter, 'opus'))).toBe('shorten-room-branch-name');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.permission).toBe('read-only');
    expect(seen[0]!.model).toBe('opus');
    expect(seen[0]!.cwd).toBe('/repo');
    expect(seen[0]!.sessionId).toBeUndefined();
  });

  it('returns null when the turn fails', async () => {
    expect(await agentBranchNamer(ctx(fakeAdapter({ ok: false, reply: 'boom' })))).toBeNull();
  });

  it('returns null when the runtime answers with prose', async () => {
    const adapter = fakeAdapter({ reply: 'I would call this one the login flakiness fix branch.' });
    expect(await agentBranchNamer(ctx(adapter))).toBeNull();
  });

  it('cancels a turn that never finishes, and still returns null', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const adapter = fakeAdapter({ hang: true, onCancel: () => (cancelled = true) });

    const pending = agentBranchNamer(ctx(adapter));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pending).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('never throws when the runtime cannot be spawned at all', async () => {
    const adapter: AgentAdapter = {
      ...fakeAdapter({}),
      run() {
        throw new Error('spawn agy ENOENT');
      },
    };
    expect(await agentBranchNamer(ctx(adapter))).toBeNull();
  });

  it('is skipped entirely when ACR_NO_AUTO_BRANCH_NAME is set', async () => {
    process.env.ACR_NO_AUTO_BRANCH_NAME = '1';
    let ran = false;
    const adapter = fakeAdapter({ reply: 'nope', onRun: () => (ran = true) });

    expect(await agentBranchNamer(ctx(adapter))).toBeNull();
    expect(ran).toBe(false);
  });
});
