import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../lib/signed-webhook.js";

describe("signed webhook verification", () => {
  const secret = "whsec_test-secret";
  const now = new Date("2026-08-06T12:00:00Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const body = Buffer.from('{"event":"deal.closed","amount":42}');

  it("accepts the exact body in the replay window", () => {
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        signature: signWebhook(secret, timestamp, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a semantically equivalent but byte-different body", () => {
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        signature: signWebhook(secret, timestamp, body),
        rawBody: '{ "event": "deal.closed", "amount": 42 }',
        now,
      }),
    ).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects stale and incomplete requests", () => {
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: String(Number(timestamp) - 301),
        signature: "sha256=nope",
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, error: "stale_timestamp" });
    expect(verifyWebhookSignature({ secret, timestamp: undefined, signature: undefined, rawBody: body, now }))
      .toEqual({ ok: false, error: "missing_signature" });
  });
});
