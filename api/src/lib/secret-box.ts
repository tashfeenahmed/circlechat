import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

// Small envelope used for connector and webhook credentials.  The deployment's
// SESSION_SECRET is already required and private; domain-separating its hash
// gives this store a dedicated 256-bit AES key without adding another mandatory
// secret to existing installs.  `v1.iv.tag.ciphertext`, all base64url.
function key(): Buffer {
  return createHash("sha256")
    .update("circlechat:credential-store:v1\0")
    .update(config.sessionSecret)
    .digest();
}

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret<T = Record<string, unknown>>(envelope: string): T {
  const [version, ivText, tagText, encryptedText] = envelope.split(".");
  if (version !== "v1" || !ivText || !tagText || encryptedText === undefined) {
    throw new Error("invalid_secret_envelope");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new Error("secret_decryption_failed");
  }
}
