// Default model per hosted Hermes provider, used when an installer (the cloud
// seed, the self-host signup, /members) sends a provider but no model.
//
// The Hermes config template ships with an Anthropic-NATIVE id
// (`model.default: claude-sonnet-5`). Every other provider spells models
// differently — OpenRouter wants `vendor/model` (`anthropic/claude-sonnet-5`)
// and 400s on the bare id — so a provider switch without a model rewrite left
// the agent unable to answer a single message (observed on a cloud trial,
// 16 Sep 2026: "Model 'claude-sonnet-4-5' isn't available on OpenRouter").
//
// Keep in sync with web/src/pages/Signup.tsx + Members.tsx `defaultModel`.
export const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-5",
  openrouter: "anthropic/claude-sonnet-5",
  "openai-codex": "gpt-4o",
  "custom:freeapi": "auto",
  // nous: intentionally absent — the Nous Portal picks a tier-appropriate
  // default when Hermes finds no model configured.
};

/** Model to write into Hermes config: the caller's pick, else the provider default, else undefined (leave Hermes to choose). */
export function resolveDefaultModel(provider: string, requested?: string | null): string | undefined {
  const r = requested?.trim();
  if (r) return r;
  return PROVIDER_DEFAULT_MODELS[provider];
}
