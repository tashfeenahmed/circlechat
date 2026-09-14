import { describe, it, expect } from "vitest";
import { agentPresenceStatus } from "../lib/agent-presence.js";

// The `presence` table had 0 rows on live, so GET /presence reported every
// member — human and agent — permanently offline. It was only ever written by
// the events WebSocket, i.e. only for humans with a tab open, and never for the
// spectator identity the public fishbowl runs on. Agents got no writer at all
// even though `working`/`idle` were already in the presence vocabulary.

describe("agentPresenceStatus", () => {
  it("maps a running agent to working", () => {
    expect(agentPresenceStatus("working")).toBe("working");
  });

  it("maps an available agent to idle — NOT offline", () => {
    // An agent between runs is available; the human stale-window rule (a tab
    // that died without a close frame) must not apply to it.
    expect(agentPresenceStatus("idle")).toBe("idle");
  });

  it("maps unavailable states to offline", () => {
    expect(agentPresenceStatus("paused")).toBe("offline");
    expect(agentPresenceStatus("error")).toBe("offline");
    expect(agentPresenceStatus("provisioning")).toBe("offline");
  });

  it("is safe on unknown or missing input", () => {
    expect(agentPresenceStatus(null)).toBe("offline");
    expect(agentPresenceStatus(undefined)).toBe("offline");
    expect(agentPresenceStatus("something-new")).toBe("offline");
  });
});
