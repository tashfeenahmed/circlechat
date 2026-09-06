// A soft-deleted message / task comment keeps its row (so thread structure,
// reaction counts and reply counts stay intact) but its BODY is gone as far as
// any reader is concerned. The delete route has zeroed `bodyMd` since it was
// written, but rows soft-deleted before that — and rows deleted by other paths
// (admin cleanup, the janitor) — still carry their original text, and the
// message-list handler used to ship them over the wire verbatim. On the public
// fishbowl that meant 131 deleted bodies were readable by anyone who opened
// devtools, even though the UI filtered them out of the rendered list.
//
// Redact on READ, not just on write: it's the only place that can't be bypassed
// by an older row or a future delete path that forgets to blank the column.

export interface SoftDeletable {
  bodyMd?: string;
  attachmentsJson?: unknown[];
  deletedAt?: Date | string | null;
}

// Returns the row unchanged when it is not deleted; otherwise a copy with an
// empty body and no attachments. Pure — safe to unit test and to map over a
// result set.
export function redactDeleted<T extends SoftDeletable>(row: T): T {
  if (!row || !row.deletedAt) return row;
  return {
    ...row,
    ...(row.bodyMd === undefined ? {} : { bodyMd: "" }),
    ...(row.attachmentsJson === undefined ? {} : { attachmentsJson: [] }),
  };
}

export function redactDeletedRows<T extends SoftDeletable>(rows: T[]): T[] {
  return rows.map(redactDeleted);
}
