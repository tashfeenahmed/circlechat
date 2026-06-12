import { describe, it, expect } from "vitest";
import { redactSecrets, redactLines } from "../lib/redaction.js";

describe("redactSecrets", () => {
  const cases: Array<{ name: string; input: string; gone: string; kept?: string }> = [
    {
      name: "authorization header",
      input: "curl -H 'Authorization: Bearer abc123def456ghi789'",
      gone: "abc123def456ghi789",
    },
    {
      name: "circlechat bot token",
      input: "using token cc_a1b2c3d4e5f6a1b2c3d4e5f6",
      gone: "a1b2c3d4e5f6a1b2c3d4e5f6",
    },
    {
      name: "freellmapi unified key",
      input: "key=freellmapi-0123456789abcdef0123456789abcdef",
      gone: "0123456789abcdef",
    },
    {
      name: "openai-style sk- key",
      input: "OPENAI_API_KEY is sk-proj-AbCdEfGh123456789012345",
      gone: "AbCdEfGh123456789012345",
    },
    {
      name: "github classic token",
      input: "pushed with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      gone: "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    },
    {
      name: "slack bot token",
      input: "xoxb-1234567890-abcdefghij",
      gone: "1234567890-abcdefghij",
    },
    {
      name: "google api key",
      input: "maps key AIzaSyA1234567890abcdefghijklmnopqrstu",
      gone: "SyA1234567890",
    },
    {
      name: "aws access key id",
      input: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      gone: "IOSFODNN7EXAMPLE",
    },
    {
      name: "jwt",
      input:
        "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      gone: "dBjftJeZ4CVP",
    },
    {
      name: "pem private key",
      input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----",
      gone: "MIIEpAIBAAKCAQEA7",
    },
    {
      name: "password assignment",
      input: "login with password=hunter2hunter2 ok",
      gone: "hunter2hunter2",
      kept: "password=",
    },
    {
      name: "api_key in json",
      input: '{"api_key": "supersecretvalue123"}',
      gone: "supersecretvalue123",
      kept: "api_key",
    },
  ];

  for (const c of cases) {
    it(`redacts ${c.name}`, () => {
      const out = redactSecrets(c.input);
      expect(out).not.toContain(c.gone);
      if (c.kept) expect(out).toContain(c.kept);
    });
  }

  it("leaves ordinary prose, ids, and hashes alone", () => {
    const benign =
      "Task task_a1b2c3 done — commit 4f5e6d7c8b9a0f1e2d3c4b5a6978 deployed to https://example.com, see m_qdu0tn3mm2b3ktzps4bv.";
    expect(redactSecrets(benign)).toBe(benign);
  });

  it("redactLines maps every element", () => {
    const out = redactLines(["ok", "Authorization: Bearer tok123456789"]);
    expect(out[0]).toBe("ok");
    expect(out[1]).not.toContain("tok123456789");
  });
});
