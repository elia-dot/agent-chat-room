import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { run } from '../src/commands/run.js';
import { EXIT } from '../src/exit.js';
import { Renderer } from '../src/render.js';
import { Capture, makeRepo } from './helpers.js';

/**
 * The M0 acceptance criterion, verbatim from PLAN.md section 6:
 *
 *   "Done when: it fixes something in a sample repo and Codex's review parses into a verdict."
 *
 * This spends real subscription turns on two real CLIs, so it is opt in. Run it with:
 *
 *   ACR_LIVE=1 npm test -- live
 *
 * `npm test` on its own never touches the network and never spawns an agent.
 */
const live = process.env.ACR_LIVE === '1';

const BROKEN = `export function add(a, b) {
  // Deliberately wrong: this subtracts.
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;

const repos: string[] = [];

afterAll(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!live)('live: claude works, codex reviews', () => {
  it(
    'fixes the sample repo and produces a parsed verdict',
    async () => {
      const dir = makeRepo({
        'math.js': BROKEN,
        'README.md': '# sample\n\nA deliberately broken `add()`.\n',
      });
      repos.push(dir);

      const capture = new Capture();
      const summary = await run({
        task:
          'math.js exports add(a, b) but the body subtracts. Fix it so add returns the sum. ' +
          'Change nothing else.',
        cwd: dir,
        agents: ['claude', 'codex'],
        timeoutMs: 20 * 60 * 1000,
        renderer: new Renderer({ color: false, write: capture.write }),
      });

      // The worker actually changed the repo.
      expect(readFileSync(join(dir, 'math.js'), 'utf8')).toContain('a + b');
      expect(summary.changedFiles).toContain('math.js');

      // Codex's review parsed into a verdict, which is the milestone.
      expect(summary.verdict?.ok).toBe(true);
      expect(summary.exitCode === EXIT.ok || summary.exitCode === EXIT.notApproved).toBe(true);
    },
    25 * 60 * 1000,
  );
});
