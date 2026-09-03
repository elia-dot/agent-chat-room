import type {
  Message,
  Participant,
  RepoRecord,
  Room,
  RuntimeReportEntry,
  TurnRecord,
} from '@agent-chat-room/core';

import type { PendingMessage } from '../state/roomStore.js';

/** What `GET /api/rooms/:id` returns. */
export interface RoomDetail {
  room: Room;
  participants: Participant[];
  messages: Message[];
  turns: TurnRecord[];
  live: PendingMessage[];
  running: boolean;
}

export interface CreateRoomRequest {
  task: string;
  cwd: string;
  agents: string[];
  title?: string;
  maxRounds?: number;
  worktree?: boolean;
  modelWorker?: string;
  modelReviewer?: string;
  start?: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface ChangedFiles {
  changed: string[];
  stat: string;
}

/** An error the server explained. Rendered to the human as-is, because it is written for them. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  if (!response.ok) {
    // Every route answers `{ error }`; a body that is not that is a bug worth surfacing.
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `${response.status} ${response.statusText}`, response.status);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>('/api/health'),

  runtimes: () => request<{ node: string; runtimes: RuntimeReportEntry[] }>('/api/runtimes'),

  rooms: (opts: { repo?: string; open?: boolean; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (opts.repo) query.set('repo', opts.repo);
    if (opts.open) query.set('open', 'true');
    if (opts.limit) query.set('limit', String(opts.limit));
    const suffix = query.toString();
    return request<Room[]>(`/api/rooms${suffix ? `?${suffix}` : ''}`);
  },

  room: (id: string) => request<RoomDetail>(`/api/rooms/${id}`),

  createRoom: (body: CreateRoomRequest) =>
    post<{ room: Room; participants: Participant[]; warnings: string[] }>('/api/rooms', body),

  say: (id: string, text: string, mention?: string) =>
    post<{ message: Message; room: Room }>(`/api/rooms/${id}/messages`, {
      text,
      ...(mention ? { mention } : {}),
    }),

  start: (id: string, directTurn?: string) =>
    post<{ room: Room }>(`/api/rooms/${id}/start`, directTurn ? { directTurn } : {}),

  pause: (id: string) => post<{ room: Room }>(`/api/rooms/${id}/pause`),
  resume: (id: string) => post<{ room: Room }>(`/api/rooms/${id}/resume`),
  stop: (id: string) => post<{ room: Room }>(`/api/rooms/${id}/stop`),
  close: (id: string) => post<{ room: Room }>(`/api/rooms/${id}/close`),

  patchRoom: (id: string, body: { maxRounds?: number; title?: string }) =>
    request<{ room: Room }>(`/api/rooms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  files: (id: string) => request<ChangedFiles>(`/api/rooms/${id}/files`),

  /** Text, not JSON: a diff is a document, and it may be megabytes. */
  diff: async (roomId: string, messageId: string): Promise<string> => {
    const response = await fetch(
      `/api/rooms/${roomId}/diff?message=${encodeURIComponent(messageId)}`,
    );
    if (!response.ok) throw new ApiError(`could not load the diff`, response.status);
    return await response.text();
  },

  repos: () => request<RepoRecord[]>('/api/repos'),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/repos/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
};
