import { describe, expect, it } from "vitest";
import { describeDeleteError, describeEditError, describeSendError, describeUploadError } from "./sendError";

// Shaped like the api client's thrown Error: message = server `error` code.
const err = (status: number | undefined, code?: string, body?: object) =>
  Object.assign(new Error(code ?? `http_${status}`), status ? { status } : {}, body ? { body } : {});

describe("describeSendError", () => {
  it("maps the API's over-limit validation error to a length message", () => {
    const e = err(400, "validation", {
      error: "validation",
      issues: [{ code: "too_big", maximum: 20000, type: "string", inclusive: true, path: ["bodyMd"], message: "String must contain at most 20000 character(s)" }],
    });
    expect(describeSendError(e)).toBe("Message too long (max 20,000 characters).");
  });
  it("does not call other validation errors 'too long'", () => {
    const e = err(400, "validation", { issues: [{ code: "invalid_type", path: ["parentId"] }] });
    expect(describeSendError(e)).toBe("Couldn’t send — try again.");
  });
  it("explains not_a_member without mentioning archiving", () => {
    const msg = describeSendError(err(403, "not_a_member"));
    expect(msg).toMatch(/no longer a member/i);
    expect(msg).not.toMatch(/archiv/i);
  });
  it("words invalid_parent without leaking the code", () => {
    const msg = describeSendError(err(400, "invalid_parent"));
    expect(msg).not.toContain("invalid_parent");
    expect(msg).toMatch(/replying to/i);
  });
  it("tells the user to slow down on 429", () => {
    expect(describeSendError(err(429))).toMatch(/too fast/i);
  });
  it("recognises an offline fetch failure (no status)", () => {
    expect(describeSendError({ message: "Failed to fetch" })).toMatch(/offline/i);
  });
  it("never leaks an unknown server code", () => {
    expect(describeSendError(err(400, "some_new_code"))).toBe("Couldn’t send — try again.");
    expect(describeSendError(err(502, "server_error"))).toBe("Couldn’t send — try again.");
    expect(describeSendError({})).toBe("Couldn’t send — try again.");
  });
});

describe("describeUploadError", () => {
  it("names the file and the reason on 413", () => {
    expect(describeUploadError(err(413), "clip.mp4")).toContain("clip.mp4");
    expect(describeUploadError(err(413), "clip.mp4")).toMatch(/too large/i);
  });
  it("falls back with the file name", () => {
    expect(describeUploadError(err(500, "no_file"), "x.png")).toBe("Couldn’t upload “x.png” — try again.");
  });
});

describe("describeEditError", () => {
  it("maps not_found (message deleted under you)", () => {
    expect(describeEditError(err(404, "not_found"))).toBe("This message is no longer here.");
  });
  it("maps not_author", () => {
    expect(describeEditError(err(403, "not_author"))).toMatch(/can.t edit/i);
  });
  it("reuses the too-long mapping for a too-long edit", () => {
    const e = err(400, "validation", {
      issues: [{ code: "too_big", path: ["bodyMd"] }],
    });
    expect(describeEditError(e)).toBe("Message too long (max 20,000 characters).");
  });
  it("generic failure says 'edit', not 'send'", () => {
    expect(describeEditError(err(500, "boom"))).toMatch(/edit/i);
    expect(describeEditError(err(500, "boom"))).not.toMatch(/send/i);
  });
  it("network failure mentions being offline", () => {
    expect(describeEditError({ message: "Failed to fetch" })).toMatch(/offline/i);
  });
});

describe("describeDeleteError", () => {
  it("maps not_found", () => {
    expect(describeDeleteError(err(404, "not_found"))).toBe("This message is no longer here.");
  });
  it("maps not_author", () => {
    expect(describeDeleteError(err(403, "not_author"))).toMatch(/can.t delete/i);
  });
  it("generic failure says 'delete', not 'send'", () => {
    const msg = describeDeleteError(err(500, "boom"));
    expect(msg).toMatch(/delete/i);
    expect(msg).not.toMatch(/send/i);
  });
});
