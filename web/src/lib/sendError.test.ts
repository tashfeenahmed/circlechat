import { describe, expect, it } from "vitest";
import { describeSendError, describeUploadError } from "./sendError";

const err = (status: number | undefined, message?: string) =>
  Object.assign(new Error(message ?? `http_${status}`), status ? { status } : {});

describe("describeSendError", () => {
  it("explains a spectator/removed 403 without blaming the network", () => {
    expect(describeSendError(err(403))).toMatch(/can’t post here/i);
  });
  it("explains a deleted conversation (404)", () => {
    expect(describeSendError(err(404))).toMatch(/no longer exists/i);
  });
  it("tells the user to slow down on 429", () => {
    expect(describeSendError(err(429))).toMatch(/too fast/i);
  });
  it("splits oversized messages on 413", () => {
    expect(describeSendError(err(413))).toMatch(/too large/i);
  });
  it("keeps the draft safe on 5xx", () => {
    expect(describeSendError(err(502))).toMatch(/still in the box/i);
  });
  it("recognises an offline fetch failure (no status)", () => {
    expect(describeSendError({ message: "Failed to fetch" })).toMatch(/offline/i);
  });
  it("falls back to the server message for other failures", () => {
    expect(describeSendError(err(undefined, "rate budget exhausted"))).toContain(
      "rate budget exhausted",
    );
  });
  it("never returns an empty string", () => {
    expect(describeSendError({}).length).toBeGreaterThan(0);
  });
});

describe("describeUploadError", () => {
  it("names the file and the reason on 413", () => {
    expect(describeUploadError(err(413), "clip.mp4")).toContain("clip.mp4");
    expect(describeUploadError(err(413), "clip.mp4")).toMatch(/too large/i);
  });
  it("says uploads are not allowed here on 403", () => {
    expect(describeUploadError(err(403), "x.png")).toMatch(/can’t attach/i);
  });
  it("falls back with the file name", () => {
    expect(describeUploadError(err(500), "x.png")).toContain("x.png");
  });
});
