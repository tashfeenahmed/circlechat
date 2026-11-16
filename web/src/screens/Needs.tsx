// SPDX-License-Identifier: AGPL-3.0-only
// Needs you: approvals waiting on a person, plus the ones decided lately.
import { useEffect, useState } from "react";
import { api, type Approval } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Filters, Icon, shortWhen, hhmm, ago } from "../ui/ui.tsx";
import { decide, decisionText, chatTitle } from "./Chats.tsx";

export function NeedsScreen({ id }: { id?: string }) {
  const { pending, agent, chat, go } = useStore();
  const [all, setAll] = useState<Approval[]>([]);
  const [filter, setFilter] = useState<"waiting" | "decided">("waiting");
  const load = () =>
    api
      .get("/api/approvals")
      .then((r) => setAll(r.approvals))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useBus((e) => {
    if (e.type === "approval") setAll((l) => [e.approval, ...l.filter((x) => x.id !== e.approval.id)]);
  });
  const decided = all.filter((a) => a.state !== "pending").slice(0, 30);
  const list = filter === "waiting" ? pending : decided;
  useEffect(() => {
    if (!id && pending.length) go(`/needs/${pending[0].id}`, true);
  }, [id, pending, go]);
  const current = all.find((a) => a.id === id) ?? pending.find((a) => a.id === id);

  return (
    <div className="main">
      <div className="list">
        <div className="list-top">
          <h2>Needs you</h2>
          <div className="small muted" style={{ marginTop: 4 }}>
            {pending.length ? `${pending.length} waiting` : "Nothing waiting"}
          </div>
        </div>
        <Filters
          value={filter}
          onChange={setFilter}
          options={[
            ["waiting", "Waiting"],
            ["decided", "Decided"],
          ]}
        />
        <div className="scroll">
          {list.length === 0 && (
            <div className="small muted" style={{ padding: "20px 24px" }}>
              {filter === "waiting" ? "All clear. Agents will ask here before anything risky." : "Nothing decided yet."}
            </div>
          )}
          {list.map((ap) => {
            const a = agent(ap.agentId);
            const c = chat(ap.chatId);
            return (
              <div key={ap.id} className={"row-chat" + (ap.id === id ? " on" : "")} onClick={() => go(`/needs/${ap.id}`)}>
                <AgentAv a={a} />
                <div className="mid">
                  <div className="t">
                    <b>{ap.detail?.tool ?? ap.detail?.title ?? ap.title}</b>
                    <time>{shortWhen(ap.createdAt)}</time>
                  </div>
                  <div className="b">
                    <span className="p">
                      {a?.name ?? "Agent"}
                      {c ? ` · ${chatTitle(c, agent)}` : ""}
                    </span>
                    {ap.state === "pending" && <span className="unread ask">!</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="convo pane" style={{ background: "var(--bg)" }}>
        {current ? (
          <Detail ap={current} />
        ) : (
          <div className="big-empty" style={{ height: "100%" }}>
            <Empty icon="inbox">{pending.length ? "Pick something on the left." : "Nothing needs you right now."}</Empty>
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ ap }: { ap: Approval }) {
  const { agent, chat, user, go, fail, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const a = agent(ap.agentId);
  const c = chat(ap.chatId);
  const d = ap.detail ?? {};
  const act = async (decision: "allow_once" | "allow_always" | "deny") => {
    setBusy(true);
    try {
      await decide(ap.id, decision);
      toast(decision === "deny" ? `Denied. ${a?.name ?? "The agent"} was told.` : "Approved");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const requester = d.requester?.type === "user" ? user(d.requester.id)?.name : d.requester?.type === "agent" ? agent(d.requester.id)?.name : "";
  const hoursLeft = Math.max(0, Math.round((ap.expiresAt - Date.now()) / 3600_000));
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 24px", width: "100%" }} className="col">
      <div className="row" style={{ gap: 14 }}>
        <AgentAv a={a} size={64} dot={false} />
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-.02em" }}>{ap.title}</h2>
          <div className="muted">
            {c ? (
              <span className="linkish" onClick={() => go(`/chats/${c.id}`)}>
                {chatTitle(c, agent)}
              </span>
            ) : (
              "No chat"
            )}{" "}
            · asked {hhmm(ap.createdAt)} ({ago(ap.createdAt)})
          </div>
        </div>
      </div>
      <div className="group" style={{ marginTop: 22, padding: "12px 14px" }}>
        <div className="small muted" style={{ marginBottom: 6 }}>
          Exact action
        </div>
        <code className="tool" style={{ background: "none", padding: 0, fontSize: 14 }}>
          {d.tool ?? (d.kind ? `sandbox.${d.kind}` : "action")}
        </code>
        {d.tool ? (
          <pre className="json" style={{ marginTop: 10 }}>
            {JSON.stringify(d.args ?? {}, null, 2)}
          </pre>
        ) : d.rawInput ? (
          <pre className="json" style={{ marginTop: 10 }}>
            {JSON.stringify(d.rawInput, null, 2)}
          </pre>
        ) : d.title ? (
          <div style={{ marginTop: 8 }}>{d.title}</div>
        ) : null}
      </div>
      <div className="group" style={{ marginTop: 12 }}>
        <div className="it">
          <span className="ic">
            <Icon n="key" />
          </span>
          Acts as
          <span className="right">{d.identity || (d.sandbox ? `${a?.name ?? "agent"} in its ${d.sandbox} sandbox` : "the agent")}</span>
        </div>
        {d.resource && (
          <div className="it">
            <span className="ic">
              <Icon n="plug" />
            </span>
            Through
            <span className="right">{d.resource}</span>
          </div>
        )}
        {d.category && (
          <div className="it">
            <span className="ic">
              <Icon n="shield" />
            </span>
            Kind
            <span className="right">{d.category === "danger" ? "Risky" : d.category === "write" ? "Changes something" : d.category}</span>
          </div>
        )}
        <div className="it">
          <span className="ic">
            <Icon n="users" />
          </span>
          Why it's asking
          <span className="right">{requester ? `${requester} asked ${a?.name ?? "the agent"}` : ap.source === "acp" ? "Its rules say ask first" : "The tool needs an OK"}</span>
        </div>
      </div>
      {ap.state === "pending" ? (
        <>
          <div className="row" style={{ gap: 10, marginTop: 22 }}>
            <button className="btn primary lg grow" disabled={busy} onClick={() => act("allow_once")}>
              Approve once
            </button>
            <button className="btn lg grow" disabled={busy} onClick={() => act("allow_always")}>
              {ap.source === "acp" ? "Always for this agent" : c ? `Always in ${chatTitle(c, agent)}` : "Always in this chat"}
            </button>
            <button className="btn lg ghost" disabled={busy} onClick={() => act("deny")}>
              Deny
            </button>
          </div>
          <div className="row small" style={{ gap: 10, marginTop: 14, color: "var(--ink-2)" }}>
            No answer in {hoursLeft} {hoursLeft === 1 ? "hour" : "hours"} means no. {a?.name ?? "The agent"} will be told.
          </div>
        </>
      ) : (
        <div style={{ marginTop: 22 }}>
          <span className={`status ${ap.state === "approved" ? "done" : ap.state === "denied" ? "blocked" : "sleeping"}`}>
            <Icon n={ap.state === "approved" ? "check" : "x"} />
            {decisionText(ap, (id) => user(id)?.name ?? "someone")}
          </span>
        </div>
      )}
    </div>
  );
}
