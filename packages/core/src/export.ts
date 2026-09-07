import type { Message, Participant, Room, TurnRecord } from './store/types.js';
import { decisionLabel } from './verdict.js';

/**
 * A room as markdown.
 *
 * Pure on purpose: the CLI, the server route and the tests all call this one function, so
 * `acr rooms export` and the browser's "Export markdown" button cannot drift apart, and the
 * whole thing is a snapshot test rather than a fixture full of HTTP.
 */
export interface RoomExportInput {
  room: Room;
  participants: Participant[];
  messages: Message[];
  turns?: TurnRecord[];
}

export function roomToMarkdown(input: RoomExportInput): string {
  const { room, participants, messages } = input;
  const turns = input.turns ?? [];
  const out: string[] = [];

  out.push(`# ${room.title}`);
  out.push('');
  out.push(`- **Room** \`${room.id}\``);
  out.push(`- **Mode** ${room.mode}`);
  out.push(`- **Repo** \`${room.repoRoot}\``);
  out.push(`- **Branch** \`${room.roomBranch}\` from \`${room.baseBranch}\``);
  if (room.baseSha) out.push(`- **Base** \`${room.baseSha}\``);
  out.push(`- **State** ${room.state}${room.paused ? ' (paused)' : ''}`);
  out.push(
    `- **Rounds** ${room.mode === 'brainstorm' ? `${room.round} of ${room.maxRounds}` : room.round}`,
  );
  if (room.prUrl) out.push(`- **Pull request** ${room.prUrl}`);
  out.push(`- **Opened** ${room.createdAt}`);
  out.push('');

  out.push('## Participants');
  out.push('');
  for (const p of participants) {
    const model = p.model ? ` · model \`${p.model}\`` : '';
    out.push(`- **${p.runtime}** – ${p.role}, ${p.permission}${model}`);
  }
  out.push('- **you** – owner');
  out.push('');

  out.push('## Task');
  out.push('');
  out.push(room.task.trim());
  out.push('');

  out.push('## Transcript');
  for (const message of messages) {
    out.push('');
    out.push(...renderMessage(message));
  }

  const usage = summariseUsage(turns);
  if (usage) {
    out.push('');
    out.push('## Usage');
    out.push('');
    out.push(usage);
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function renderMessage(message: Message): string[] {
  if (message.kind === 'system') {
    // System lines are the room's own narration – round boundaries, approval counts – so
    // they read as asides rather than as another speaker.
    return [`> _${message.text.trim().replace(/\n/g, '\n> ')}_`];
  }

  const out: string[] = [];
  const bits = [message.author];
  if (message.role) bits.push(message.role);
  if (message.round > 0) bits.push(`round ${message.round}`);
  const verdict = message.verdict ? ` — **${decisionLabel(message.verdict.decision)}**` : '';
  out.push(`### ${bits.join(' · ')}${verdict}`);
  out.push('');
  out.push(message.text.trim() || '_(no text)_');

  if (message.verdict) {
    for (const item of message.verdict.blocking) out.push(`- **blocking** ${item}`);
    for (const item of message.verdict.nits) out.push(`- nit: ${item}`);
  }

  if (message.activity.length > 0) {
    out.push('');
    out.push('<details><summary>activity</summary>');
    out.push('');
    for (const event of message.activity) {
      if (event.type === 'tool') out.push(`- \`${event.name}\` ${event.summary}`.trimEnd());
      else if (event.type === 'file') out.push(`- ${event.op} \`${event.path}\``);
    }
    out.push('');
    out.push('</details>');
  }

  if (message.diff !== null) {
    out.push('');
    out.push('<details><summary>diff</summary>');
    out.push('');
    out.push('```diff');
    out.push(message.diff.replace(/\n+$/, ''));
    out.push('```');
    out.push('');
    out.push('</details>');
  } else if (message.diffPath) {
    // A diff too large for a row lives next to the database. Naming the file is more use
    // than inlining megabytes into a document somebody is about to paste into an issue.
    out.push('');
    out.push(`_Diff too large to inline; it is at \`${message.diffPath}\`._`);
  }

  return out;
}

function summariseUsage(turns: TurnRecord[]): string | undefined {
  if (turns.length === 0) return undefined;
  const wallMs = turns.reduce((ms, t) => {
    if (!t.endedAt) return ms;
    const span = Date.parse(t.endedAt) - Date.parse(t.startedAt);
    return ms + (Number.isFinite(span) && span > 0 ? span : 0);
  }, 0);
  const tokens = turns.reduce((sum, t) => sum + (t.usage?.totalTokens ?? 0), 0);
  const seconds = Math.round(wallMs / 1000);
  const bits = [`${turns.length} turn${turns.length === 1 ? '' : 's'}`, `${seconds}s of wall time`];
  // Not every runtime reports tokens, so a zero means "not reported" rather than "free".
  bits.push(tokens > 0 ? `${tokens.toLocaleString('en-US')} tokens` : 'tokens not reported');
  return bits.join(' · ');
}
