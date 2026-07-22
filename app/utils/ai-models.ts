/**
 * Selectable Claude models, shared between the server (validation, the LLM call)
 * and the admin UI (the dropdown).
 *
 * Lives in a plain module — not a `.server` one — because the admin component
 * renders the picker on the client, and Remix strips `.server` imports from the
 * client bundle. First entry is the default when a merchant hasn't picked.
 */
export const CLAUDE_MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest & cheapest" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
] as const;

export const CLAUDE_DEFAULT_MODEL = CLAUDE_MODELS[0].id;
