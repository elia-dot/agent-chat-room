import type { ModelCatalog, ModelOption } from '@agent-chat-room/core';

/**
 * The options a model `<select>` should show.
 *
 * `current` is always in the list, even when the catalog has never heard of it: a model
 * typed by hand, or one set before the CLI's list changed, must survive a re-render rather
 * than silently snapping back to "default".
 */
export function optionsFor(
  catalog: ModelCatalog | undefined,
  current: string | undefined,
): ModelOption[] {
  const models = catalog?.models ?? [];
  const value = current?.trim() ?? '';
  if (value === '' || models.some((m) => m.id === value)) return models;
  // First, not last: it is the selected one, and a list of forty cursor models would
  // otherwise bury it. The control says separately that the catalog has never seen it.
  return [{ id: value }, ...models];
}

/** Exact match only: `opus` is a model, `opus-5` is not one just because it starts the same. */
export function isKnownModel(catalog: ModelCatalog | undefined, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return (catalog?.models ?? []).some((m) => m.id === trimmed);
}

/** Index the route's payload by runtime, which is how every caller wants to read it. */
export function byRuntime(catalogs: ModelCatalog[]): Record<string, ModelCatalog> {
  return Object.fromEntries(catalogs.map((c) => [c.runtime, c]));
}
