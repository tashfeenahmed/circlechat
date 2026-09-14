// Read-time scrub for text bodies served to the public.
//
// `sanitizeAgentProse` (agents/reply-guard.ts) cleans what an agent WRITES into
// a message or comment. It never sees a file: an agent writes markdown to
// /workspace and attaches it, and the bytes go to storage verbatim — which is
// correct, because the agent reads them back and the paths inside have to
// still resolve. But those same bytes are then served, unchanged, to anonymous
// visitors on live.circlechat.co, quoting `/opt/data/workspace/...` and
// `/workspace/auditor_manifest_sha256.json` at people who have no container to
// open them in.
//
// So this runs on the READ path only, and only for the public identity:
// storage keeps the original bytes, agents and signed-in members keep the
// original bytes, and the fishbowl visitor gets the filenames without the
// mount points.
//
// Deliberately light. It rewrites container paths and strips environment
// variable assignments, and touches nothing else — a deliverable is somebody's
// work, and an over-eager rewrite would corrupt it. Same vocabulary as
// web/src/lib/md.ts (`scrubIds`) so one document reads the same in the file
// viewer and in a chat quote.

// Absolute paths under the agent's mounts. The leading group is the delimiter
// (kept verbatim, including a backtick) so we don't need a lookbehind.
const CONTAINER_PATH_RE =
  /(^|[\s("'`[<])(\/(?:opt\/data|workspace|tmp)(?:\/[\w.@%+-]+)*)\/?/g;

// `HERMES_WRITE_SAFE_ROOT=/opt/data`, `VERIFY_FAIL_MODE=hold` — runtime knobs,
// never part of a deliverable's meaning.
const ENV_ASSIGN_RE = /\b[A-Z][A-Z0-9_]{3,}=(?:"[^"\n]*"|'[^'\n]*'|\S+)/g;

// Largest body we will rewrite. Above this we serve the original: the scrub
// has to buffer the whole file to do it, and a multi-megabyte deliverable is
// not what the paths-in-prose problem is about.
export const MAX_SCRUB_BYTES = 1024 * 1024;

// Pure. Returns the text with container paths reduced to their bare filename
// and env-var assignments removed.
export function scrubInternalPaths(text: string): string {
  let out = String(text ?? "");
  out = out.replace(CONTAINER_PATH_RE, (m: string, pre: string, p: string) => {
    // A trailing slash means it was a directory reference — there is no
    // filename worth showing, so the whole thing goes.
    if (m.endsWith("/")) return pre;
    const last = p.split("/").filter(Boolean).pop() ?? "";
    const keep = last && last !== "workspace" && last !== "tmp" && last !== "data" ? last : "";
    return `${pre}${keep}`;
  });
  out = out.replace(ENV_ASSIGN_RE, "");
  // Tidy what the removals leave behind, without touching line structure
  // (markdown and HTML both care about newlines).
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/\(\s*\)/g, "");
}
