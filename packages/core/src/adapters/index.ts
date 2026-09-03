import type { AgentAdapter, Detection } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { echoAdapter } from './echo.js';

export { claudeAdapter, ClaudeParser, buildClaudeArgs } from './claude.js';
export { codexAdapter, CodexParser, buildCodexArgs, buildCodexPrompt } from './codex.js';
export { echoAdapter, resetEchoAdapter, describeRequest } from './echo.js';
export type { EchoScript, EchoTurn, EchoTurnSelector } from './echo.js';

/**
 * Every runtime `acr` knows about. Adding one is meant to be a single line here plus a file
 * next to it – that is the whole promise of the adapter interface.
 *
 * `echo` is a test double and only reports itself installed when `ACR_ECHO_SCRIPT` is set,
 * so it never shows up as available in a real `acr doctor`.
 */
export const adapters: Record<string, AgentAdapter> = {
  [claudeAdapter.id]: claudeAdapter,
  [codexAdapter.id]: codexAdapter,
  [echoAdapter.id]: echoAdapter,
};

/** Runtimes listed by `acr doctor`, in display order. */
export const adapterList: AgentAdapter[] = [claudeAdapter, codexAdapter, echoAdapter];

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters[id];
}

export interface DetectionResult {
  adapter: AgentAdapter;
  detection: Detection;
}

export async function detectAll(list: AgentAdapter[] = adapterList): Promise<DetectionResult[]> {
  return Promise.all(list.map(async (adapter) => ({ adapter, detection: await adapter.detect() })));
}

/** True when a runtime is installed, new enough, and has credentials on disk. */
export function isUsable(detection: Detection): boolean {
  return detection.installed && detection.minVersionOk && detection.loggedIn !== false;
}
