import { describe, it, expect } from "vitest";
import { formatDelegationBrief } from "../lib/delegation.js";

describe("formatDelegationBrief", () => {
  it("includes the objective and names the delegator", () => {
    const b = formatDelegationBrief({ fromHandle: "samantha", objective: "Write the launch copy" });
    expect(b).toContain("@samantha");
    expect(b).toContain("Objective:");
    expect(b).toContain("Write the launch copy");
    expect(b).toContain("share_to_task"); // the "how to finish" footer
  });

  it("omits constraints and done-criteria when not given", () => {
    const b = formatDelegationBrief({ fromHandle: "x", objective: "do a thing" });
    expect(b).not.toContain("Constraints:");
    expect(b).not.toContain("Done when:");
  });

  it("includes constraints and done-criteria when given", () => {
    const b = formatDelegationBrief({
      fromHandle: "x",
      objective: "build the page",
      constraints: "use the brand palette only",
      doneWhen: "renders on mobile + desktop",
    });
    expect(b).toContain("use the brand palette only");
    expect(b).toContain("renders on mobile + desktop");
    expect(b).toMatch(/Constraints/);
    expect(b).toMatch(/Done when/);
  });

  it("tells the delegatee they don't need the delegator's history (context filtering)", () => {
    const b = formatDelegationBrief({ fromHandle: "rachel", objective: "x" });
    expect(b.toLowerCase()).toContain("don't need to read");
  });
});
