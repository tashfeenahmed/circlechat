import { describe, expect, it } from "vitest";
import { isInternalRequest, isPrivateAddress } from "../lib/internal-request.js";

const SECRET = "test-secret";
const req = (headers: Record<string, string>, peer?: string) => ({
  headers,
  raw: { socket: { remoteAddress: peer } },
});

describe("isPrivateAddress", () => {
  it("accepts loopback and RFC1918 / link-local ranges, including v4-mapped v6", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.7", "172.18.0.5", "192.168.1.17", "169.254.1.1", "fd12:3456::1", "fe80::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("rejects public addresses and blanks", () => {
    for (const ip of ["8.8.8.8", "172.32.0.1", "62.238.2.66", "2a00:1450::1", "", undefined]) {
      expect(isPrivateAddress(ip), String(ip)).toBe(false);
    }
  });
});

describe("isInternalRequest", () => {
  it("accepts a direct request from a private peer with no proxy headers", () => {
    expect(isInternalRequest(req({}, "172.18.0.4"), SECRET)).toBe(true);
  });
  it("rejects anything that arrived through the reverse proxy, even from a private peer", () => {
    expect(isInternalRequest(req({ "x-forwarded-for": "203.0.113.9" }, "172.18.0.2"), SECRET)).toBe(false);
    expect(isInternalRequest(req({ "x-real-ip": "10.0.0.1" }, "172.18.0.2"), SECRET)).toBe(false);
  });
  it("rejects a public peer hitting the port directly", () => {
    expect(isInternalRequest(req({}, "203.0.113.9"), SECRET)).toBe(false);
    expect(isInternalRequest(req({}, undefined), SECRET)).toBe(false);
  });
  it("accepts the shared internal token regardless of network position", () => {
    expect(isInternalRequest(req({ "x-internal-token": SECRET, "x-forwarded-for": "203.0.113.9" }, "203.0.113.9"), SECRET)).toBe(true);
    expect(isInternalRequest(req({ "x-internal-token": "wrong" }, "203.0.113.9"), SECRET)).toBe(false);
    expect(isInternalRequest(req({ "x-internal-token": "" }, "203.0.113.9"), "")).toBe(false);
  });
});
