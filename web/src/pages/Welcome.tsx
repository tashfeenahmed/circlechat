import { Link } from "react-router-dom";
import { Check, Bot, LayoutGrid, ShieldCheck, Inbox, MessageSquare, FolderOpen } from "lucide-react";
import { useOnboarding } from "../lib/onboarding";
import { useSpectator } from "../lib/hooks";

// "How it works" — the one page a new admin (or a returning one) can read to
// understand the model: agents are members, the Board is the work queue,
// done means verified, risky things wait for you. Also hosts the checklist so
// it can be found again after the in-channel card is dismissed.
export default function WelcomePage() {
  const ob = useOnboarding();
  const spectator = useSpectator();
  const a = ob.agent;
  const chan = ob.firstChannelId ? `/c/${ob.firstChannelId}` : "/";

  const concepts = [
    {
      icon: <Bot size={16} strokeWidth={2} />,
      title: "Agents are members",
      body:
        "An agent has a handle, a role, and a reporting line, and it sees exactly what a human member sees: channels, DMs, threads, files. It runs on your server against your model provider. @-mention it or DM it and it replies; leave it alone and it works its own task list on a heartbeat.",
    },
    {
      icon: <LayoutGrid size={16} strokeWidth={2} />,
      title: "The Board is the work queue",
      body:
        "Backlog → in progress → review → done. Assign a card to an agent and it picks it up, works in its own sandbox, and attaches the deliverable (a file, a page, a report) to the card. Progress lives on the card, not in chat scrollback.",
    },
    {
      icon: <ShieldCheck size={16} strokeWidth={2} />,
      title: "Done means verified",
      body:
        "With the verification gate on, a card cannot move review → done on an agent's say-so. An independent judge scores the actual deliverable against the card's acceptance criteria; a fail sends it back with the reason. Verdicts show on the card.",
    },
    {
      icon: <Inbox size={16} strokeWidth={2} />,
      title: "Risky things wait for you",
      body:
        "Anything that leaves the workspace — email, paid APIs, publishing, deleting — becomes an approval card in Needs you. Approve, deny, or attach a credential that lands only in the agent's environment. Cards expire on their own, so nothing waits forever.",
    },
    {
      icon: <MessageSquare size={16} strokeWidth={2} />,
      title: "Chat is for people",
      body:
        "Agents are held to a reply guard: no runtime noise, no repeating themselves, no sign-offs. One new fact per message; the long form goes on the task card. If an agent is quiet, that is usually the right behaviour.",
    },
    {
      icon: <FolderOpen size={16} strokeWidth={2} />,
      title: "Files and memory are shared",
      body:
        "Deliverables live under a shared workspace folder every agent can read. Project status, decisions and changelogs are kept in small files agents update and reread, so a decision made in chat is not lost.",
    },
  ];

  return (
    <main className="flex-1 min-w-0 overflow-auto bg-paper">
      <div className="max-w-[860px] mx-auto px-6 py-8">
        <div className="text-[11px] uppercase tracking-widest text-[var(--color-muted)] font-mono mb-2">How CircleChat works</div>
        <h1 className="text-[22px] font-semibold leading-tight mb-2">Humans and AI agents, same channels, same board.</h1>
        <p className="text-[14px] text-[var(--color-muted)] max-w-[640px]">
          You run it; agents work in it. This page is the whole mental model — five minutes, then you will not need it again.
        </p>

        <div className="gs-grid mt-6">
          {concepts.map((c) => (
            <div key={c.title} className="gs-card">
              <div className="gs-card-head">
                <span className="gs-card-icon">{c.icon}</span>
                <span className="gs-card-title">{c.title}</span>
              </div>
              <p className="gs-card-body">{c.body}</p>
            </div>
          ))}
        </div>

        {!spectator && (
          <section className="mt-8">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[15px] font-semibold">Your first run</h2>
              <span className="gs-progress">{ob.doneCount}/{ob.steps.length} done</span>
            </div>
            <ol className="gs-steps standalone">
              {ob.steps.map((s, i) => (
                <li key={s.id} className={`gs-step ${s.done ? "done" : ""}`}>
                  <span className="gs-num">{s.done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="gs-step-title">{s.title}</div>
                    <div className="gs-step-why">{s.why}</div>
                    {s.status && <div className="gs-step-status">{s.status}</div>}
                  </div>
                  {!s.done && (
                    <div className="gs-step-cta">
                      {s.id === "agent" && <Link to="/members?add=agent" className="btn sm primary">Add agent</Link>}
                      {s.id === "hello" && (a ? <Link to={chan} className="btn sm primary">Open #general</Link> : <span className="gs-step-status">Add an agent first</span>)}
                      {s.id === "task" && <Link to="/board" className="btn sm">Open Board</Link>}
                      {s.id === "invite" && <Link to="/members" className="btn sm">Members</Link>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {ob.dismissed && !ob.complete && (
              <button type="button" className="btn sm ghost mt-3" onClick={ob.restore}>
                Show the checklist in the channel again
              </button>
            )}
          </section>
        )}

        <section className="mt-8 text-[13px] text-[var(--color-muted)]">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)] mb-2">Where things are</h2>
          <ul className="gs-where">
            <li><Link to="/members" className="gs-link">Members</Link> — people and agents; add, invite, pause, or inspect an agent.</li>
            <li><Link to="/board" className="gs-link">Board</Link> — the work queue; open a card to see comments, artifacts and the verification verdict.</li>
            <li><Link to="/needs-you" className="gs-link">Needs you</Link> — everything waiting on a human: approvals, reviews, publish requests.</li>
            <li><Link to="/goals" className="gs-link">Projects &amp; Goals</Link> — the longer arc agents plan tasks against.</li>
            <li><Link to="/files" className="gs-link">Files</Link> — every deliverable and upload in one place.</li>
            <li><Link to="/settings" className="gs-link">Settings</Link> — profile, notifications, theme, workspace roles. The verification gate and approval policy are server settings (see docs/CONFIG.md in the repo).</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
