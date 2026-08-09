import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../lib/secret-box.js";

describe("credential envelope", () => {
  it("round trips without exposing plaintext and detects tampering", () => {
    const value = { bearerToken: "top-secret", headers: { "x-api-key": "hidden" } };
    const envelope = encryptSecret(value);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("top-secret");
    expect(decryptSecret(envelope)).toEqual(value);
    const parts = envelope.split(".");
    parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
    expect(() => decryptSecret(parts.join("."))).toThrow("secret_decryption_failed");
  });
});
