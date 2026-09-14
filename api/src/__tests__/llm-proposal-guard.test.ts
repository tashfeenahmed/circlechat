import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkProposal,
  checkTitle,
  isPlaceholderText,
  GOAL_LIMITS,
  TASK_LIMITS,
  STRICTER_RETRY_NOTE,
} from "../lib/llm-proposal-guard.js";
import { composeBody } from "../lib/mission-planner.js";
import { filterPlannedTasks } from "../lib/planner.js";
import { acceptJanitorOutput } from "../lib/memory-janitor.js";

// The goal the mission planner actually created on live (14 Sep 2026),
// goal_p6ohf87smk1b70if7rgs: the model copied the prompt's example JSON instead
// of writing content, and the planner inserted it verbatim.
const LIVE_JUNK = {
  title: "...",
  description: "what done looks like",
  rationale: "why this is the next move for the mission",
};

afterEach(() => vi.restoreAllMocks());

describe("the live junk proposal", () => {
  it("is rejected", () => {
    const verdict = checkProposal({ title: LIVE_JUNK.title, body: composeBody(LIVE_JUNK) }, GOAL_LIMITS);
    expect(verdict.ok).toBe(false);
  });

  it("is rejected on its body too, not just its three-character title", () => {
    const body = composeBody(LIVE_JUNK);
    expect(body).toBe("what done looks like\n\n_Why now: why this is the next move for the mission_");
    const verdict = checkProposal({ title: "Ship the mission planner content gate", body }, GOAL_LIMITS);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/filler|too short/);
  });

  it("recognises each template phrase on its own", () => {
    expect(isPlaceholderText("...")).toBe(true);
    expect(isPlaceholderText("what done looks like")).toBe(true);
    expect(isPlaceholderText("why this is the next move for the mission")).toBe(true);
    expect(isPlaceholderText("why this task + why this owner")).toBe(true);
    expect(isPlaceholderText("exact project title or empty")).toBe(true);
  });
});

describe("a normal proposal", () => {
  const good = {
    title: "Publish the read-only public board for spectators",
    description:
      "A logged-out visitor opening /b/<slug> sees the columns, cards and card detail of the shared board, with agent internals and private history left out.",
    rationale: "",
  };

  it("passes", () => {
    expect(checkProposal({ title: good.title, body: composeBody(good) }, GOAL_LIMITS).ok).toBe(true);
  });

  it("passes with the _Why now:_ italic line filled in", () => {
    const withWhy = { ...good, rationale: "the launch demo needs a link we can paste into a tweet" };
    const body = composeBody(withWhy);
    expect(body).toContain("_Why now: the launch demo needs");
    expect(checkProposal({ title: withWhy.title, body }, GOAL_LIMITS).ok).toBe(true);
  });

  it("survives a body that merely mentions a template phrase in real prose", () => {
    const body =
      "What done looks like here: every provisioning failure emails the owner within a minute, and the trial clock resets so the customer is not billed for a box that never came up. Verified against the control plane's requeue path.";
    expect(checkProposal({ title: "Email the owner when provisioning fails", body }, GOAL_LIMITS).ok).toBe(true);
  });
});

describe("title rules", () => {
  it("rejects a title that is too short, wordless or letterless", () => {
    for (const t of ["...", "Ship it", "12 34 56 78", "   "]) {
      expect(checkTitle(t, GOAL_LIMITS).ok, t).toBe(false);
    }
  });

  it("rejects a title over the column budget", () => {
    expect(checkTitle("a ".repeat(200), GOAL_LIMITS).ok).toBe(false);
  });

  it("accepts an ordinary three-word outcome", () => {
    expect(checkTitle("Migrate the billing webhook", GOAL_LIMITS).ok).toBe(true);
  });
});

describe("body rules", () => {
  it("rejects a goal body under the minimum", () => {
    const v = checkProposal({ title: "Migrate the billing webhook", body: "do it" }, GOAL_LIMITS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("body too short");
  });

  it("allows an empty task description (optional in the schema) but not a filler one", () => {
    expect(checkProposal({ title: "Migrate the billing webhook", body: "" }, TASK_LIMITS).ok).toBe(true);
    expect(checkProposal({ title: "Migrate the billing webhook", body: "what done looks like" }, TASK_LIMITS).ok).toBe(
      false,
    );
  });
});

describe("filterPlannedTasks (goal decomposition)", () => {
  const base = { key: "t1", assignee: "", dependsOn: [], labels: [], rationale: "", description: "" };

  it("drops a task whose title is template filler and keeps the real ones", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = filterPlannedTasks(
      [
        { ...base, key: "t1", title: "...", description: "what done looks like" },
        { ...base, key: "t2", title: "Draft the launch announcement copy", description: "One page, reviewed by Rachel." },
      ],
      "goal_x",
    );
    expect(kept.map((t) => t.key)).toEqual(["t2"]);
  });

  it("blanks a filler description instead of dropping the task", () => {
    const kept = filterPlannedTasks(
      [
        {
          ...base,
          title: "Draft the launch announcement copy",
          description: "what done looks like",
          rationale: "why this task + why this owner",
        },
      ],
      "goal_x",
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].description).toBe("");
    expect(kept[0].rationale).toBe("");
  });

  it("keeps a real description and rationale untouched", () => {
    const kept = filterPlannedTasks(
      [
        {
          ...base,
          title: "Draft the launch announcement copy",
          description: "Two paragraphs plus a screenshot, ready to post.",
          rationale: "Rachel owns customer-facing copy",
        },
      ],
      "goal_x",
    );
    expect(kept[0].description).toContain("screenshot");
    expect(kept[0].rationale).toContain("Rachel");
  });
});

describe("the stricter retry instruction", () => {
  it("names the filler it must not repeat", () => {
    expect(STRICTER_RETRY_NOTE).toContain("what done looks like");
    expect(STRICTER_RETRY_NOTE.toLowerCase()).toContain("placeholder");
  });
});

describe("memory janitor", () => {
  it("never overwrites the team block with prompt filler", () => {
    expect(acceptJanitorOutput("what done looks like", 3000).accept).toBe(false);
  });

  it("still accepts a real whiteboard rewrite", () => {
    expect(acceptJanitorOutput("Landing page shipped. Rachel on copy, Ben on billing.", 3000).accept).toBe(true);
  });
});
