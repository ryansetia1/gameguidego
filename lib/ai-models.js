/** Default Replicate model; admin choice (app_settings) and REPLICATE_MODEL override it. */
export const DEFAULT_MODEL = "google/gemini-3-flash";

/**
 * @typedef {{ prompt: string; system: string; maxTokens: number; temperature?: number; images?: string[] }} ModelCall
 */

/** @param {ModelCall} call */
function geminiInput({ prompt, system, maxTokens, temperature, images }) {
  // thinking_level defaults to "none", which is what every call here wants.
  return {
    prompt,
    system_instruction: system,
    ...(images?.length ? { images } : {}),
    ...(temperature != null ? { temperature } : {}),
    max_output_tokens: maxTokens,
  };
}

/** @param {ModelCall} call */
function gptInput({ prompt, system, maxTokens, images }) {
  // No temperature on this model. reasoning_effort "none" matches Gemini's thinking off.
  return {
    prompt,
    system_prompt: system,
    ...(images?.length ? { image_input: images } : {}),
    max_completion_tokens: maxTokens,
    reasoning_effort: "none",
  };
}

/**
 * The admin allowlist. The only place that knows each model's input schema and price.
 * The label must always include the model version ("GPT-5.6 Sol", never "GPT sol").
 * price: USD per 1M tokens from the Replicate model pages (checked 2026-11-24).
 * GPT-5.6 Sol is an estimate: its page still shows an expired "50% off until Sept 18"
 * note and no undiscounted price.
 */
export const AI_MODELS = {
  "google/gemini-3-flash": {
    label: "Gemini 3 Flash",
    input: geminiInput,
    price: { inputPerM: 0.5, outputPerM: 3 },
  },
  "openai/gpt-5.6-sol": {
    label: "GPT-5.6 Sol",
    input: gptInput,
    price: { inputPerM: 2.5, outputPerM: 15 },
  },
};

/** Rate for ids outside the allowlist (e.g. old google/gemini-2.5-flash rows). */
export const FALLBACK_MODEL_PRICE = { inputPerM: 0.3, outputPerM: 2.5 };

/**
 * USD per 1M tokens for a stored model id.
 * @param {unknown} id
 * @returns {{ inputPerM: number; outputPerM: number }}
 */
export function modelPrice(id) {
  return isAllowedModel(id) ? AI_MODELS[id].price : FALLBACK_MODEL_PRICE;
}

/**
 * Admin-only display: versioned label, or the raw id for unknown/custom models.
 * @param {unknown} id
 */
export function adminModelName(id) {
  return modelLabel(id) || (typeof id === "string" ? id : "");
}

/** @param {unknown} id @returns {id is keyof typeof AI_MODELS} */
export function isAllowedModel(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(AI_MODELS, id);
}

/** Display name for a stored model id; "" for unknown ids (never show the raw id).
 * @param {unknown} id
 */
export function modelLabel(id) {
  return isAllowedModel(id) ? AI_MODELS[id].label : "";
}

/**
 * Map generic call options onto the model's Replicate input. Unknown ids (e.g. a
 * custom REPLICATE_MODEL) get the Gemini shape, as before the allowlist existed.
 * @param {string} model
 * @param {ModelCall} call
 */
export function buildModelInput(model, call) {
  return (isAllowedModel(model) ? AI_MODELS[model].input : geminiInput)(call);
}
