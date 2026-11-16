// SPDX-License-Identifier: AGPL-3.0-only
// People and agents: agent cards with live status, people with roles.
import { useState } from "react";
import { api, type Role } from "../api.ts";
import { useStore } from "../store.tsx";
import { AgentAv, Icon, Modal, StatusPill, UserAv, vis } from "../ui/ui.tsx";

const ROLE_NAMES: Record<Role, string> = { owner: "Owner", admin: "Admin", builder: "Builder", member: "Member" };
const ROLE_HINT: Record<Role, string> = {
  owner: "Everything",
  admin: "Settings, people, keys",
  builder: "Adds agents and integrations",
  member: "Chats with people and agents",
};

export function PeopleScreen() {
  const { agents, users, me, go, isAdmin, isBuilder, fail, reloadUsers, toast } = useStore();
  const [adding, setAdding] = useState(false);
  const setRole = async (id: string, role: Role) => {
    try {
      await api.patch(`/api/users/${id}`, { role });
      await reloadUsers();
      toast("Role changed");
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="main solo">
      <div className="convo pane">
        <div className="page wide">
          <div className="row">
            <h2 className="h2">People and agents</h2>
            {isBuilder && (
              <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => go("/agents/new")}>
                <Icon n="plus" size="sm" />
                Add an agent
              </button>
            )}
          </div>
          <div className="sect">Agents · {agents.length}</div>
          {agents.length === 0 ? (
            <div className="group" style={{ padding: 24, textAlign: "center" }} >
              <div className="muted">No agents yet. Add one to start.</div>
            </div>
          ) : (
            <div className="agrid">
              {agents.map((a) => (
                <div key={a.id} className="group agent-card" onClick={() => go(`/agents/${a.id}`)}>
                  <AgentAv a={a} size={84} dot={false} />
                  <div style={{ fontWeight: 600, marginTop: 6 }}>{a.name}</div>
                  <div className="small muted">{a.roleTitle || `@${a.handle}`}</div>
                  <div style={{ marginTop: 8 }}>
                    <StatusPill s={a.status} text={vis(a.status) === "working" && a.status.detail ? truncate(a.status.detail, 22) : undefined} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <div className="sect grow">People · {users.length}</div>
            {isAdmin && (
              <button className="btn sm" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
                <Icon n="plus" size="sm" />
                Add a person
              </button>
            )}
          </div>
          <div className="group">
            {users.map((u) => (
              <div key={u.id} className="it">
                <UserAv u={u} dot={u.id === me.id} />
                <div className="grow">
                  <b style={{ fontWeight: 600 }}>{u.name}</b>
                  <div className="small muted">
                    {u.email}
                    {u.id === me.id ? " · you" : ""}
                  </div>
                </div>
                {isAdmin && u.role !== "owner" && u.id !== me.id ? (
                  <select className="input sm" style={{ width: 150 }} value={u.role} onChange={(e) => setRole(u.id, e.target.value as Role)} aria-label={`Role for ${u.name}`}>
                    {(["admin", "builder", "member"] as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_NAMES[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="right" title={ROLE_HINT[u.role]}>
                    {ROLE_NAMES[u.role]}
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            Admins manage settings and people. Builders add agents and integrations. Members chat.
          </p>
        </div>
      </div>
      {adding && <AddPersonModal onClose={() => setAdding(false)} />}
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function AddPersonModal({ onClose }: { onClose: () => void }) {
  const { fail, reloadUsers } = useStore();
  const [f, setF] = useState({ name: "", email: "", role: "member" as Role });
  const [done, setDone] = useState<{ email: string; pw: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/users", f);
      await reloadUsers();
      setDone({ email: r.user.email, pw: r.tempPassword });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a person"
      onClose={onClose}
      width={480}
      footer={
        done ? (
          <button className="btn primary" style={{ marginLeft: "auto" }} onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !f.name.trim() || !f.email.trim()} onClick={add}>
              Add
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="form">
          <div>They can sign in now. Send them this, then they can change it later.</div>
          <div className="group" style={{ padding: "12px 14px" }}>
            <div className="kv">
              <dt>Email</dt>
              <dd>{done.email}</dd>
              <dt>Password</dt>
              <dd>
                <code>{done.pw}</code>
              </dd>
            </div>
          </div>
          <div className="small muted">This password is shown once.</div>
        </div>
      ) : (
        <div className="form">
          <div>
            <label className="label">Name</label>
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
              <option value="member">Member: chats with people and agents</option>
              <option value="builder">Builder: also adds agents and integrations</option>
              <option value="admin">Admin: also settings, people and keys</option>
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}
