import { Link } from "react-router-dom";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import type { OnboardingState } from "../lib/onboarding";

interface Props {
  state: OnboardingState;
  // Puts text into the channel composer (used by "Say hello").
  onPrefill?: (text: string) => void;
}

// Compact first-run card shown at the top of a new workspace's first channel.
// Every step is derived from live data (see lib/onboarding.ts) and ticks itself.
export default function GettingStarted({ state, onPrefill }: Props) {
  const [open, setOpen] = useState(true);
  if (!state.ready || state.dismissed || state.complete) return null;
  const a = state.agent;

  return (
    <section className="gs" aria-label="Getting started">
      <div className="gs-head">
        <div className="min-w-0">
          <div className="gs-title">Welcome to CircleChat</div>
          <div className="gs-sub">
            Team chat where AI agents are members. They read the channels, take work from the Board, do it in
            their own sandbox, and ask you before anything risky.{" "}
            <Link to="/welcome" className="gs-link">How it works →</Link>
          </div>
        </div>
        <div className="gs-actions">
          <span className="gs-progress">{state.doneCount}/{state.steps.length}</span>
          <button type="button" className="gs-icon" onClick={() => setOpen((v) => !v)} title={open ? "Collapse" : "Expand"}>
            {open ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
          </button>
          <button type="button" className="gs-icon" onClick={state.dismiss} title="Hide getting started (find it again under Show more → How it works)">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      {open && (
        <ol className="gs-steps">
          {state.steps.map((s, i) => (
            <li key={s.id} className={`gs-step ${s.done ? "done" : ""}`}>
              <span className="gs-num">{s.done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="gs-step-title">{s.title}</div>
                {!s.done && <div className="gs-step-why">{s.why}</div>}
                {s.status && !s.done && s.id !== "agent" ? null : s.status && <div className="gs-step-status">{s.status}</div>}
              </div>
              {!s.done && (
                <div className="gs-step-cta">
                  {s.id === "agent" && <Link to="/members?add=agent" className="btn sm primary">Add agent</Link>}
                  {s.id === "hello" && a && (
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => onPrefill?.(`@${a.handle} hello! What can you do in this workspace?`)}
                    >
                      Mention @{a.handle}
                    </button>
                  )}
                  {s.id === "hello" && !a && <span className="gs-step-status">Add an agent first</span>}
                  {s.id === "task" && <Link to="/board" className="btn sm">Open Board</Link>}
                  {s.id === "invite" && <Link to="/members" className="btn sm">Members</Link>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
