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

/** The admin allowlist. The only place that knows each model's input schema. */
export const AI_MODELS = {
  "google/gemini-3-flash": { label: "Gemini 3 Flash", input: geminiInput },
  "openai/gpt-5.6-sol": { label: "GPT sol", input: gptInput },
};

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
