// User-facing copy for a failed send/upload. Lives apart from the Composer so
// the mapping is testable without a DOM (this package has no RTL harness) and
// greppable when new error codes need wording.
//
// The api client throws Errors carrying `status` and the server's `error`
// string (see api/client.ts). Network failures never reach fetch's result, so
// they surface as a TypeError with no status.

export interface SendErrorLike {
  status?: number
  message?: string
}

export function describeSendError(err: SendErrorLike): string {
  switch (err.status) {
    case 403:
      return "You can’t post here — you may have been removed or the channel is archived."
    case 404:
      return "This conversation no longer exists. It may have been deleted."
    case 408:
      return "The server took too long to respond. Try again."
    case 413:
      return "That message is too large. Try splitting it or uploading the file separately."
    case 429:
      return "You’re sending too fast. Wait a moment and try again."
    default:
      break
  }
  if (err.status && err.status >= 500) {
    return "CircleChat hit an error while sending. Your text is still in the box."
  }
  // No status at all: fetch rejected (offline, DNS, server down).
  if (err.message && /fetch|network|load failed/i.test(err.message)) {
    return "You appear to be offline. Your text is still in the box."
  }
  return err.message ? `Couldn’t send: ${err.message}` : "Couldn’t send the message. Your text is still in the box."
}

export function describeUploadError(err: SendErrorLike, fileName: string): string {
  if (err.status === 413) return `“${fileName}” is too large to upload.`
  if (err.status === 403) return `You can’t attach files here.`
  return `Upload of “${fileName}” failed. Try again.`
}
