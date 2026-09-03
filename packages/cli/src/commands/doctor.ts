import { detectAll, isUsable } from '@agent-chat-room/core';

import { EXIT, type ExitCode } from '../exit.js';
import { Renderer } from '../render.js';

const NODE_RECOMMENDED_MAJOR = 22;

export interface DoctorOptions {
  json?: boolean;
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

  if (opts.json) {
    const payload = results.map(({ adapter, detection }) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      ...detection,
      usable: isUsable(detection),
    }));
    process.stdout.write(
      `${JSON.stringify({ node: process.version, runtimes: payload }, null, 2)}\n`,
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
