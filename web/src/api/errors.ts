const MESSAGES: Record<string, string> = {
  email_in_use: "That email is already registered. Try signing in instead.",
  handle_in_use: "That handle is taken. Pick another.",
  workspace_handle_in_use: "That workspace handle is taken.",
  invalid_credentials: "Wrong email or password.",
  unauthenticated: "Your session has expired. Sign in again.",
  unauthorized: "You don't have permission to do that.",
  not_a_member: "You aren't a member of that workspace.",
  not_admin: "Only workspace admins can do that.",
  no_workspace_selected: "Pick a workspace first.",
  no_workspace: "You aren't in a workspace yet.",
  already_accepted: "That invite has already been used.",
  not_found: "Not found.",
  validation: "Some fields are missing or invalid.",
  freeapi_base_url_required: "FreeLLMAPI needs a base URL (e.g. http://your-server:3200/v1).",
  hermes_home_exists: "An agent with that handle already has a Hermes directory. Pick a different handle.",
  hermes_setup_failed: "Hermes setup failed. Check Docker is running + the hermes image is available.",
  openclaw_home_exists: "An agent with that handle already has an OpenClaw directory. Pick a different handle.",
  openclaw_setup_failed: "OpenClaw setup failed. Check Docker is running + the openclaw image is available.",
  unsupported_openclaw_provider: "OpenClaw doesn't support that inference provider. Pick Anthropic, OpenAI, OpenRouter, or FreeLLMAPI.",
};

export function humanizeError(e: unknown): string {
  if (!e) return "Something went wrong.";
  const msg = e instanceof Error ? e.message : String(e);
  if (msg in MESSAGES) return MESSAGES[msg];
  if (msg.startsWith("http_")) return `Server error (${msg.slice(5)}). Try again.`;
  return "Something went wrong. Try again.";
}
