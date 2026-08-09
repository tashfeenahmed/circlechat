import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;

export function signWebhook(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(rawBody)
    .digest("hex")}`;
}

export function verifyWebhookSignature(opts: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string | Buffer;
  now?: Date;
  maxSkewSeconds?: number;
}): { ok: true } | { ok: false; error: "missing_signature" | "stale_timestamp" | "bad_signature" } {
  if (!opts.timestamp || !opts.signature) return { ok: false, error: "missing_signature" };
  const timestampSeconds = Number(opts.timestamp);
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > (opts.maxSkewSeconds ?? WEBHOOK_MAX_SKEW_SECONDS)
  ) {
    return { ok: false, error: "stale_timestamp" };
  }
  const expected = Buffer.from(signWebhook(opts.secret, opts.timestamp, opts.rawBody), "utf8");
  const actual = Buffer.from(opts.signature.trim(), "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, error: "bad_signature" };
  }
  return { ok: true };
}
