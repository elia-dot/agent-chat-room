import type {
  Detection,
  Message,
  Participant,
  RepoRecord,
  Role,
  Room,
  RoomMode,
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
  mode?: RoomMode;
  maxRounds?: number;
  worktree?: boolean;
  modelWorker?: string;
  modelReviewer?: string;
  /** Per-runtime model override, keyed by runtime id. */
  models?: Record<string, string>;
  start?: boolean;
}

/** `GET /api/runtimes`. `gh` rides along so "Open PR" can explain itself when it is absent. */
export interface RuntimesResponse {
  node: string;
  runtimes: RuntimeReportEntry[];
  gh: Detection;
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

/** `GET /api/repos/picker` – whether this host can show a native folder dialog at all. */
export interface PickerStatus {
  available: boolean;
  tool: 'osascript' | 'powershell' | 'zenity' | 'kdialog' | null;
}

/** `POST /api/repos/pick`. `cancelled` is the human dismissing the dialog, not an error. */
export type PickResult = { path: string; repoRoot: string | null } | { cancelled: true };

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

  runtimes: () => request<RuntimesResponse>('/api/runtimes'),

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

  /** Role swap and model picker: one route, because both change a participant of a live room. */
  setParticipant: (id: string, runtime: string, body: { role?: Role; model?: string }) =>
    request<{ participants: Participant[] }>(
      `/api/rooms/${id}/participants/${encodeURIComponent(runtime)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  commit: (id: string, message?: string) =>
    post<{ room: Room; sha?: string }>(`/api/rooms/${id}/commit`, message ? { message } : {}),

  openPr: (id: string, body: { title?: string; remote?: string; draft?: boolean } = {}) =>
    post<{ room: Room; url?: string }>(`/api/rooms/${id}/pr`, body),

  promote: (id: string, body: { agents?: string[]; title?: string } = {}) =>
    post<{ room: Room; participants: Participant[] }>(`/api/rooms/${id}/promote`, body),

  /** A plain link, so the browser downloads it rather than the app buffering it. */
  exportUrl: (id: string) => `/api/rooms/${id}/export.md`,

  files: (id: string) => request<ChangedFiles>(`/api/rooms/${id}/files`),

  /** Text, not JSON: a diff is a document, and it may be megabytes. */
  diff: async (roomId: string, messageId: string): Promise<string> => {
    const response = await fetch(
      `/api/rooms/${roomId}/diff?message=${encodeURIComponent(messageId)}`,
    );
    if (!response.ok) throw new ApiError(`could not load the diff`, response.status);
    return await response.text();
  },

  repos: (limit?: number) => request<RepoRecord[]>(`/api/repos${limit ? `?limit=${limit}` : ''}`),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/repos/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  pickerStatus: () => request<PickerStatus>('/api/repos/picker'),

  /**
   * Opens a folder dialog on the machine running the server, which for `acr serve` is this
   * one. POST because it spawns a GUI process – see the route for why that matters.
   */
  pickFolder: (path?: string) => post<PickResult>('/api/repos/pick', path ? { path } : {}),
};
