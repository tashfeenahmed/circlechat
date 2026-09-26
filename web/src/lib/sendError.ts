// User-facing copy for a failed send/upload. Lives apart from the Composer so
// the mapping is testable without a DOM (this package has no RTL harness) and
// greppable when new error codes need wording.
//
// The api client throws Errors whose message is the server's `error` code
// (e.g. "not_a_member") and which carry `status` and the parsed `body` (see
// api/client.ts). Network failures never reach fetch's result, so they surface
// as a TypeError with no status. Raw codes are never shown to the user: an
// unknown failure gets a generic line.

export interface SendErrorLike {
  status?: number
  message?: string
  body?: { error?: string; issues?: unknown }
}

// Matches the server's PostBody/EditBody limit (api/src/routes/messages.ts).
export const MAX_MESSAGE_CHARS = 20_000

const GENERIC = "Couldn’t send — try again."

// A zod `too_big` issue on bodyMd: how the API reports an over-long message
// (400 {error:"validation", issues:[{code:"too_big", path:["bodyMd"], …}]}).
function isTooLong(err: SendErrorLike): boolean {
  if (err.status !== 400 || err.message !== "validation") return false
  const issues = err.body?.issues
  if (!Array.isArray(issues)) return false
  return issues.some((i) => {
    const issue = i as { code?: string; path?: unknown[] }
    return issue.code === "too_big" && Array.isArray(issue.path) && issue.path[0] === "bodyMd"
  })
}

export function describeSendError(err: SendErrorLike): string {
  if (isTooLong(err)) return "Message too long (max 20,000 characters)."
  switch (err.message) {
    case "not_a_member":
      return "You’re no longer a member of this conversation."
    case "invalid_parent":
      return "The message you’re replying to is no longer available."
    case "body_too_large":
      return "Message too large to send."
  }
  if (err.status === 429) return "You’re sending too fast — wait a moment and try again."
  if (err.status === undefined && err.message && /fetch|network|load failed/i.test(err.message)) {
    return "You appear to be offline — try again when you’re reconnected."
  }
  return GENERIC
}

// Edit + delete share the message routes' failure codes (api/src/routes/
// messages.ts PATCH/DELETE: 404 not_found, 403 not_author, 400 validation
// too_big). Silent catches here used to mean an edit that vanished or a
// delete that didn't happen with no explanation.
export function describeEditError(err: SendErrorLike): string {
  if (isTooLong(err)) return "Message too long (max 20,000 characters)."
  switch (err.message) {
    case "not_found":
      return "This message is no longer here."
    case "not_author":
      return "You can’t edit this message."
  }
  if (err.status === 429) return "You’re editing too fast — wait a moment and try again."
  if (err.status === undefined && err.message && /fetch|network|load failed/i.test(err.message)) {
    return "You appear to be offline — try again when you’re reconnected."
  }
  return "Couldn’t save the edit — try again."
}

export function describeDeleteError(err: SendErrorLike): string {
  switch (err.message) {
    case "not_found":
      return "This message is no longer here."
    case "not_author":
      return "You can’t delete this message."
  }
  if (err.status === 429) return "You’re moving too fast — wait a moment and try again."
  if (err.status === undefined && err.message && /fetch|network|load failed/i.test(err.message)) {
    return "You appear to be offline — try again when you’re reconnected."
  }
  return "Couldn’t delete the message — try again."
}

export function describeUploadError(err: SendErrorLike, fileName: string): string {
  if (err.status === 413) return `“${fileName}” is too large to upload.`
  return `Couldn’t upload “${fileName}” — try again.`
}
