import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_INLINE_DIFF_BYTES, buildTurnPrompt } from '../src/prompt.js';
import { NO_MOVING_GOALPOSTS, roleInstructions } from '../src/roles.js';

const base = {
  runtime: 'claude',
  role: 'worker' as const,
  title: 'fix the flaky login test',
  round: 1,
  cwd: '/repo',
  branch: 'acr/flaky-login',
  task: 'The login test fails every fifth run on CI.',
};

describe('buildTurnPrompt', () => {
  it('omits only role instructions when delivered separately', () => {
    const input = {
      ...base,
      newMessages: [{ author: 'owner', text: 'Keep the redirect.' }],
      diff: '+fixed',
      testResults: '1 test passed',
      roleChanged: 'You were a reviewer; you are now the worker.',
    };
    const full = buildTurnPrompt(input);
    const compact = buildTurnPrompt({ ...input, includeRoleInstructions: false });
    expect(full).toBe(`${compact}\n## Your job now\n${roleInstructions('worker')}\n`);
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(full));
  });

  it('points at attached files by absolute path rather than trying to inline them', () => {
    const prompt = buildTurnPrompt({
      ...base,
      newMessages: [
        {
          author: 'you',
          role: 'owner',
          text: 'this is what it looks like',
          attachments: [
            {
              name: 'shot.png',
              mime: 'image/png',
              path: '/config/attachments/r1/a1.png',
              kind: 'image',
            },
            {
              name: 'auth.md',
              mime: 'text/markdown',
              path: '/config/attachments/r1/a2.md',
              kind: 'room',
              roomRef: { slug: 'auth-spike', title: 'The auth spike' },
            },
          ],
        },
      ],
    });

    expect(prompt).toContain('Attached, on disk – open these files:');
    expect(prompt).toContain('image `shot.png` (image/png): `/config/attachments/r1/a1.png`');
    expect(prompt).toContain('transcript of room "The auth spike" (`auth-spike`)');
    expect(prompt).toContain('`/config/attachments/r1/a2.md`');
  });

  it('says nothing about attachments when a message has none', () => {
    const prompt = buildTurnPrompt({ ...base, newMessages: [{ author: 'you', text: 'go on' }] });
    expect(prompt).not.toContain('Attached, on disk');
  });

  it('retains round-specific reviewer rules in inline instructions', () => {
    expect(buildTurnPrompt({ ...base, role: 'reviewer', round: 3 })).toContain(NO_MOVING_GOALPOSTS);
  });

  it.each(['answer', 'react', 'merge'] as const)('retains the %s phase instructions', (phase) => {
    expect(buildTurnPrompt({ ...base, phase })).toContain(roleInstructions('worker', { phase }));
  });

  it('matches the layout in PLAN.md section 4.2', () => {
    expect(buildTurnPrompt(base)).toMatchInlineSnapshot(`
      "You are claude acting as WORKER in room "fix the flaky login test" (round 1).
      Repo: /repo on branch acr/flaky-login.

      ## Task
      The login test fails every fifth run on CI.

      ## Your job now
      You are the WORKER. You are the only participant allowed to change files.

      - Make the smallest change that actually solves the task, and make it in the working tree.
      - Run the project's own tests or type checks if it has them, and say what you ran.
      - Reply with a short summary: what you changed, why, and anything you deliberately did not do.
      - Do not commit, do not create branches, and do not push. The engine handles version control.
      - You are working in a fresh git worktree, so build artefacts and installed dependencies may
        not be there. If a command fails because of a missing install, say so instead of installing
        the world – the human decides what a room is allowed to download.
      - If the task is ambiguous, pick the most reasonable reading, state the assumption, and continue.
      "
    `);
  });

  it('renders new messages with author, role, round and verdict', () => {
    const prompt = buildTurnPrompt({
      ...base,
      round: 2,
      newMessages: [
        { author: 'elia', text: 'also check the redirect' },
        {
          author: 'codex',
          role: 'reviewer',
          round: 1,
          verdict: 'request-changes',
          text: 'tests/login.spec.ts:41 the timeout is too short',
        },
      ],
    });
    expect(prompt).toContain('## New messages since your last turn');
    expect(prompt).toContain('[elia]');
    expect(prompt).toContain('[codex · reviewer · round 1] (verdict: request-changes)');
    expect(prompt).toContain('tests/login.spec.ts:41');
  });

  it('inlines a small diff', () => {
    const prompt = buildTurnPrompt({
      ...base,
      role: 'reviewer',
      diffStat: ' a.ts | 2 +-',
      diff: '--- a/a.ts\n+++ b/a.ts\n-old\n+new\n',
    });
    expect(prompt).toContain('## Changes in this room so far');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('+new');
  });

  it('tells the agent to run git itself when the diff is too big to inline', () => {
    const huge = `+${'x'.repeat(DEFAULT_MAX_INLINE_DIFF_BYTES + 1)}`;
    const prompt = buildTurnPrompt({
      ...base,
      role: 'reviewer',
      diffStat: ' a.ts | 9999 +',
      diff: huge,
      diffCommand: 'git diff abc123',
    });
    expect(prompt).not.toContain('```diff');
    expect(prompt).toContain('too large to inline');
    expect(prompt).toContain('git diff abc123');
  });

  it('points a read-only reviewer at a file when the diff is too big to inline', () => {
    // `permissions.ts` gives a reviewer `--tools Read,Glob,Grep,Skill,Bash`, so telling it to run
    // `git diff` is advice it cannot act on. Reading a file is something it still can do.
    const huge = `+${'x'.repeat(DEFAULT_MAX_INLINE_DIFF_BYTES + 1)}`;
    const prompt = buildTurnPrompt({
      ...base,
      role: 'reviewer',
      diff: huge,
      diffFile: '/tmp/acr/diffs/msg.diff',
      diffCommand: 'git diff abc123',
    });
    expect(prompt).toContain('/tmp/acr/diffs/msg.diff');
    expect(prompt).toContain('read that file');
  });

  it('ends with the role instructions for the reviewer, including the verdict rule', () => {
    const prompt = buildTurnPrompt({ ...base, role: 'reviewer' });
    expect(prompt).toContain('You must not edit, create or delete any file');
    expect(prompt).toContain('Cite `file:line`');
    expect(prompt).toContain('```verdict');
  });
});
