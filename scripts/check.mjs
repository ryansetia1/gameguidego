import assert from "node:assert/strict";

import { buildPrompt } from "../lib/prompt.js";

const prompt = buildPrompt({
  game: "Link's Awakening",
  platform: "Game Boy",
  question: "How do I open the gate?",
  sources: [{ title: "Test guide", content: "Use the Omega Key." }],
  history: [
    { role: "user", content: "Where is the first dungeon?" },
    { role: "assistant", content: "Head east from the beach." },
  ],
});

assert.match(prompt, /Game: Link's Awakening/);
assert.match(prompt, /Platform: Game Boy/);
assert.match(prompt, /How do I open the gate\?/);
assert.match(prompt, /Use the Omega Key\./);
assert.match(prompt, /Player: Where is the first dungeon\?/);
assert.match(prompt, /Guide: Head east from the beach\./);
assert.match(prompt, /untrusted reference text/);

const noHistory = buildPrompt({
  question: "What now?",
  sources: [{ title: "T", content: "C" }],
});
assert.doesNotMatch(noHistory, /Conversation so far/);
assert.match(noHistory, /Game: unspecified/);

console.log("Prompt self-check passed.");
