// SPDX-License-Identifier: AGPL-3.0-only
// Passwords (scrypt), the secrets vault (AES-256-GCM) and ids.
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

export function id(prefix = ""): string {
  return prefix + randomBytes(10).toString("base64url");
}
export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt" || !s || !k) return false;
  const key = scryptSync(pw, Buffer.from(s, "base64url"), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, "base64url");
  return want.length === key.length && timingSafeEqual(want, key);
}

/** Vault: secrets are encrypted at rest with a master key that never enters an agent sandbox. */
export class Vault {
  private key: Buffer;
  constructor(masterKeyB64: string) {
    const k = Buffer.from(masterKeyB64, "base64url");
    if (k.length !== 32) throw new Error("CIRCLECHAT_MASTER_KEY must be 32 bytes, base64url");
    this.key = k;
  }
  seal(plain: string): { iv: string; tag: string; data: string } {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), data: data.toString("base64url") };
  }
  open(box: { iv: string; tag: string; data: string }): string {
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(box.iv, "base64url"));
    d.setAuthTag(Buffer.from(box.tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(box.data, "base64url")), d.final()]).toString("utf8");
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
export function hmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
