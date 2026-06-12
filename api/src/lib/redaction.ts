// Shared secret redaction for anything we persist or export: run traces,
// executor errors, agent message bodies, and the external tracing payload.
// Approval-delivered credentials live in agent env vars and inevitably get
// echoed into shell transcripts — the patterns here catch the common token
// shapes before they land in Postgres or a third-party trace backend.
//
// Patterns are deliberately conservative: provider-prefixed token formats and
// explicit key=value assignments only. No generic "long hex" matching — ids,
// hashes, and commit SHAs would all false-positive.

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers, any scheme.
  [/\b(authorization\s*:\s*)(?:bearer|basic|token)\s+\S+/gi, "$1***"],
  // CircleChat bot tokens.
  [/\bcc_[a-z0-9]{20,}\b/gi, "cc_***"],
  // FreeLLMAPI unified keys.
  [/\bfreellmapi-[a-f0-9]{16,}\b/gi, "freellmapi-***"],
  // OpenAI / Anthropic / Stripe style "sk-" (and sk_live_/sk_test_) keys.
  [/\bsk[-_](?:live_|test_|proj_|ant_)?[A-Za-z0-9_-]{16,}\b/g, "sk-***"],
  // GitHub tokens (classic + fine-grained + app).
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "gh*_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***"],
  // Slack tokens.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox*-***"],
  // Google API keys.
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, "AIza***"],
  // AWS access key ids (the paired secret has no stable shape; the id alone
  // is the searchable half).
  [/\bAKIA[A-Z0-9]{16}\b/g, "AKIA***"],
  // JWTs (three base64url segments, header always starts eyJ).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "eyJ***.***.***"],
  // PEM private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key redacted]"],
  // Explicit assignments: password=…, api_key: …, token=… (shell, env, JSON,
  // YAML, query strings). Keeps the name, drops the value.
  [
    /\b((?:pass(?:word)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*)(["']?)[^\s"'&,;]{6,}\2/gi,
    "$1$2***$2",
  ],
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}

export function redactLines(lines: string[]): string[] {
  return lines.map((l) => redactSecrets(l));
}
