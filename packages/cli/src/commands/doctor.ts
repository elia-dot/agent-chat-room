import { detectAll, isUsable, listAllModels, runtimeReport } from '@agent-chat-room/core';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';

const NODE_RECOMMENDED_MAJOR = 22;

export interface DoctorOptions {
  json?: boolean;
  /** Also list the models each installed runtime offers. Off by default: it can spawn. */
  models?: boolean;
  renderer?: Renderer;
}

/**
 * `acr doctor` – which runtimes are installed, new enough, and logged in.
 *
 * Detection never spawns an agent CLI beyond `--version`, and never reads credentials; it
 * only checks that a credentials file exists.
 */
export async function doctor(opts: DoctorOptions = {}): Promise<ExitCode> {
  const results = await detectAll();
  // Same function `GET /api/runtimes/models` calls, so the terminal and the browser can
  // never disagree about which models you may ask for.
  const catalogs = opts.models ? await listAllModels() : [];

  if (opts.json) {
    // Exactly what `GET /api/runtimes` serves, so the doctor page and this command can
    // never drift apart.
    const payload = await runtimeReport();
    process.stdout.write(
      `${JSON.stringify(
        {
          node: process.version,
          runtimes: payload,
          ...(opts.models ? { models: catalogs } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const r = opts.renderer ?? new Renderer();
    r.line('Runtimes');
    r.line();
    const rows = results.map(({ adapter, detection }) => ({
      name: adapter.displayName,
      id: adapter.id,
      installed: detection.installed ? 'yes' : 'no',
      version: detection.version ?? '-',
      minOk: detection.installed ? (detection.minVersionOk ? 'ok' : 'too old') : '-',
      login: detection.loggedIn === undefined ? '?' : detection.loggedIn ? 'yes' : 'no',
      note: detection.note ?? '',
    }));
    const width = (pick: (row: (typeof rows)[number]) => string, header: string): number =>
      Math.max(header.length, ...rows.map((row) => pick(row).length));

    const cols: { header: string; pick: (row: (typeof rows)[number]) => string }[] = [
      { header: 'runtime', pick: (row) => row.name },
      { header: 'id', pick: (row) => row.id },
      { header: 'installed', pick: (row) => row.installed },
      { header: 'version', pick: (row) => row.version },
      { header: 'min', pick: (row) => row.minOk },
      { header: 'login', pick: (row) => row.login },
      { header: 'note', pick: (row) => row.note },
    ];
    const widths = cols.map((c) => width(c.pick, c.header));
    const renderRow = (cells: string[]): string =>
      cells
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd();

    r.line(renderRow(cols.map((c) => c.header)));
    r.line(renderRow(widths.map((w) => '-'.repeat(w))));
    for (const row of rows) r.line(renderRow(cols.map((c) => c.pick(row))));

    if (opts.models) {
      for (const catalog of catalogs) {
        r.line();
        r.line(
          `${catalog.runtime} models (${catalog.source === 'cli' ? 'from the CLI' : 'built in'})`,
        );
        if (catalog.note) r.line(`  ${catalog.note}`);
        if (catalog.models.length === 0) {
          r.line('  none reported');
        } else {
          for (const model of catalog.models) {
            r.line(`  ${model.id}${model.label ? `  ${model.label}` : ''}`);
          }
        }
      }
      r.line();
      r.line('Any other name still works: a model string the list cannot hold, such as');
      r.line('`claude-opus-5[1m]`, is passed to the runtime untouched.');
    }

    r.line();
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (nodeMajor < NODE_RECOMMENDED_MAJOR) {
      r.line(
        `warning: node ${process.versions.node} is below the recommended ${NODE_RECOMMENDED_MAJOR}.x (see .nvmrc)`,
      );
    }
  }

  // The whole point of the project is two agents talking to each other, so one usable
  // runtime is a failure state worth reporting to a script.
  const usable = results.filter(({ detection }) => isUsable(detection));
  if (usable.length < 2) {
    if (!opts.json) {
      const r = opts.renderer ?? new Renderer();
      r.error(
        `only ${usable.length} usable runtime${usable.length === 1 ? '' : 's'} detected; acr needs at least 2`,
      );
    }
    return EXIT.internalError;
  }
  return EXIT.ok;
}
