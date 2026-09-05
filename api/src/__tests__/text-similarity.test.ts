import { describe, it, expect } from "vitest";
import { findNearDuplicate, normalizeText, textSimilarity } from "../lib/text-similarity.js";

// Pure core behind the cross-message dedupe (agents/dedupe.ts) and the
// project-tracker append dedupe (lib/project-files.ts). Cases are the real
// repeats seen on live.circlechat.co.

describe("normalizeText", () => {
  it("drops URLs, @mentions, punctuation and case", () => {
    expect(normalizeText("Ping @nova — see https://x.test/a, OK?")).toBe("ping see ok");
  });
});

describe("findNearDuplicate", () => {
  const backend = "Backend is live and verified — `node server.js` on port 3000, health endpoint returns 200.";

  it("flags the same body reposted verbatim by another agent", () => {
    const hit = findNearDuplicate(backend, [{ id: "tc_2", bodyMd: "unrelated comment about the landing page copy" }, { id: "tc_1", bodyMd: backend }]);
    expect(hit?.candidate.id).toBe("tc_1");
    expect(hit?.score).toBe(1);
  });

  it("flags a near-identical restatement (different mention/punctuation)", () => {
    const hit = findNearDuplicate(
      "Backend is live and verified: node server.js on port 3000; health endpoint returns 200 @iris",
      [{ id: "tc_1", bodyMd: backend }],
    );
    expect(hit).not.toBeNull();
  });

  it("flags 'Proof package vNN shipped' repeats regardless of the version number token", () => {
    const a = "Proof package v28 shipped: hashes recomputed, HLS relay re-verified live, status.md updated with the new checksums.";
    const b = "Proof package v30 shipped: hashes recomputed, HLS relay re-verified live, status.md updated with the new checksums.";
    expect(textSimilarity(a, b)).toBeGreaterThanOrEqual(0.85);
  });

  it("does not flag genuinely different progress", () => {
    const hit = findNearDuplicate(
      "Switched the relay to the new origin and re-ran the smoke test — three of five streams still 404, digging into the manifest paths.",
      [{ id: "tc_1", bodyMd: backend }],
    );
    expect(hit).toBeNull();
  });

  it("skips short bodies on either side (acks repeat naturally)", () => {
    expect(findNearDuplicate("ok thanks", [{ id: "m1", bodyMd: "ok thanks" }])).toBeNull();
    expect(findNearDuplicate(backend, [{ id: "m1", bodyMd: "on it" }])).toBeNull();
  });

  it("returns the FIRST match in the given order (callers pass newest first)", () => {
    const hit = findNearDuplicate(backend, [{ id: "new", bodyMd: backend }, { id: "old", bodyMd: backend }]);
    expect(hit?.candidate.id).toBe("new");
  });
});
