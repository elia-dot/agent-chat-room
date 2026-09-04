/**
 * A rejected model reads the same from every vendor: a 404 wrapped in a sentence about the
 * name. Claude 2.1.x answers `model_not_found` / `unrecognized_model`, Codex and Cursor
 * relay their provider's wording. Matching the shape rather than one vendor's string keeps
 * the hint useful when that wording changes.
 *
 * This lives on its own rather than in `models.ts` so the adapters can use it without
 * importing the catalog, which imports them back.
 */
const REJECTION_RE =
  /\b(model[_ ]not[_ ]found|unrecognized[_ ]model|unknown[_ ]model|invalid[_ ]model)\b|\bmodel\b[^\n]{0,120}?\b(does not exist|doesn't exist|not exist|not found|no access|unrecognized|is invalid|is not available)\b/i;

/**
 * A sentence to append when a turn died because the vendor did not recognise the model.
 * `undefined` for every other failure, so an ordinary error is not decorated with advice
 * about a model that was fine.
 */
export function modelRejectionHint(model: string | undefined, text: string): string | undefined {
  if (!text || !REJECTION_RE.test(text)) return undefined;
  const named = model ? `"${model}"` : 'that model';
  return `The model ${named} was rejected by the runtime. Pick one from the model list in the right panel (or the new-room dialog) – it shows what this runtime actually offers.`;
}

/** `reported`, with the model hint appended when one applies. */
export function withModelHint(reported: string, model: string | undefined): string {
  const hint = modelRejectionHint(model, reported);
  return hint ? `${reported}\n\n${hint}` : reported;
}
