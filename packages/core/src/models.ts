import { adapterList, getAdapter } from './adapters/index.js';
import type { AgentAdapter, ModelOption } from './types.js';

/**
 * What the model picker offers for one runtime.
 *
 * `source` is part of the payload on purpose: a list a CLI just printed and a list this
 * repo hard-coded a month ago deserve different confidence, and the UI says which it is
 * showing rather than pretending they are the same thing.
 */
export interface ModelCatalog {
  runtime: string;
  models: ModelOption[];
  source: 'cli' | 'static';
  /** Why the static list is being shown, when the live one was meant to be. */
  note?: string;
}

export interface ListModelsOptions {
  /** Ignore anything already cached and ask the CLI again. */
  refresh?: boolean;
}

/**
 * Listing a runtime's models can mean a network round trip (`cursor-agent --list-models`
 * is account-specific), and the new-room dialog asks on open. Five minutes is long enough
 * that opening three dialogs costs one spawn, and short enough that logging in to a new
 * account shows up without restarting the server.
 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * A little longer than the 10 s `readStdout` gives a probe, so a well-behaved adapter times
 * out on its own terms and this is only the backstop for one that never resolves. A hung
 * listing must not become a hung HTTP request.
 */
const LIST_TIMEOUT_MS = 12_000;

const cache = new Map<string, { at: number; catalog: ModelCatalog }>();

/** Drops every cached catalog. Tests call this; so could a future `acr doctor --refresh`. */
export function resetModelCache(): void {
  cache.clear();
}

/**
 * The catalog for one runtime. Never throws and never rejects: a picker that cannot render
 * because a CLI misbehaved is worse than a picker showing a slightly stale list.
 */
export async function listModels(
  runtime: string,
  opts: ListModelsOptions = {},
): Promise<ModelCatalog> {
  const adapter = getAdapter(runtime);
  if (!adapter) return { runtime, models: [], source: 'static', note: `unknown runtime` };
  return listModelsFor(adapter, opts);
}

async function listModelsFor(
  adapter: AgentAdapter,
  opts: ListModelsOptions = {},
): Promise<ModelCatalog> {
  const hit = cache.get(adapter.id);
  if (!opts.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.catalog;

  const catalog = await buildCatalog(adapter);
  cache.set(adapter.id, { at: Date.now(), catalog });
  return catalog;
}

async function buildCatalog(adapter: AgentAdapter): Promise<ModelCatalog> {
  const fallback = (note?: string): ModelCatalog => ({
    runtime: adapter.id,
    models: (adapter.capabilities.models ?? []).map((id) => ({ id })),
    source: 'static',
    ...(note ? { note } : {}),
  });

  if (!adapter.listModels) return fallback();

  try {
    const models = await withTimeout(adapter.listModels(), LIST_TIMEOUT_MS);
    if (models.length === 0) {
      return fallback(`${adapter.displayName} listed no models; showing the names we know`);
    }
    return { runtime: adapter.id, models, source: 'cli' };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return fallback(`could not ask ${adapter.displayName} (${why}); showing the names we know`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // `unref` so a pending listing never keeps `acr doctor --models` alive after it printed.
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Every installed runtime's catalog, the way `runtimeReport()` reports every runtime's
 * detection – one function behind both `GET /api/runtimes/models` and `acr doctor
 * --models`, so the browser and the terminal cannot disagree about what you may type.
 *
 * Runtimes that are not installed are skipped rather than listed empty: there is no model
 * to pick for a CLI that is not there, and asking would spawn nothing anyway.
 */
export async function listAllModels(
  list: AgentAdapter[] = adapterList,
  opts: ListModelsOptions = {},
): Promise<ModelCatalog[]> {
  const detections = await Promise.all(
    list.map(async (adapter) => ({ adapter, detection: await adapter.detect() })),
  );
  return Promise.all(
    detections
      .filter(({ detection }) => detection.installed)
      .map(({ adapter }) => listModelsFor(adapter, opts)),
  );
}

export { modelRejectionHint } from './modelHint.js';
