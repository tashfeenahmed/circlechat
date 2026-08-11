import { describe, expect, it } from "vitest";
import { parsePublicHttpUrl } from "../lib/safe-fetch.js";

describe("agent URL SSRF guard", () => {
  it("accepts normal public HTTP(S) URLs", () => {
    expect(parsePublicHttpUrl("https://example.com/file.txt").hostname).toBe("example.com");
    expect(parsePublicHttpUrl("http://example.com/path").protocol).toBe("http:");
  });

  it.each([
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://postgres:5432/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
  ])("rejects unsafe target %s", (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow("unsafe_url");
  });
});
