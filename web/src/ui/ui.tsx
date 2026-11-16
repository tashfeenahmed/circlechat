// SPDX-License-Identifier: AGPL-3.0-only
// Small shared building blocks: icons, avatars, status, toggles, modals, formatting.
import { useEffect, type CSSProperties, type ReactNode } from "react";
import type { Agent, AgentStatus, Member, User } from "../api.ts";
import { useStore } from "../store.tsx";

// ---------------------------------------------------------------- icons (sprite lives in Sprite.tsx)
export function Icon({ n, size, className = "", style }: { n: string; size?: "sm" | "lg"; className?: string; style?: CSSProperties }) {
  return (
    <svg className={`i ${size ?? ""} ${className}`} style={style} aria-hidden="true">
      <use href={`#i-${n}`} />
    </svg>
  );
}

// ---------------------------------------------------------------- looks
export const STYLES = ["classic", "twin", "curly", "spring", "heart", "leafy", "bulb", "trio", "stubby", "halo", "nightlight", "huggy", "feelers"];
export const STYLE_NAMES: Record<string, string> = {
  classic: "Classic",
  twin: "Twin",
  curly: "Curly",
  spring: "Spring",
  heart: "Heart",
  leafy: "Leafy",
  bulb: "Bulb",
  trio: "Trio",
  stubby: "Stubby",
  halo: "Halo",
  nightlight: "Night light",
  huggy: "Huggy",
  feelers: "Feelers",
};
export const COLOURS: Record<string, { hex: string; tint: string; ink: string }> = {
  coral: { hex: "#FF5533", tint: "#FFE6DF", ink: "#B23418" },
  peach: { hex: "#FF9433", tint: "#FFEBD9", ink: "#A0520C" },
  butter: { hex: "#FFC814", tint: "#FFF4C7", ink: "#8A6400" },
  mint: { hex: "#1FD69A", tint: "#D9F8EC", ink: "#0E7A55" },
  green: { hex: "#62D23A", tint: "#E3F8D9", ink: "#3A7D1C" },
  sky: { hex: "#3C93FF", tint: "#E0ECFF", ink: "#1F55B8" },
  lilac: { hex: "#9466FF", tint: "#ECE4FF", ink: "#5530C4" },
  pink: { hex: "#FF4F9A", tint: "#FFE2EF", ink: "#AD2463" },
  cloud: { hex: "#F7F7F5", tint: "#F2F2F1", ink: "#5B5B57" },
  midnight: { hex: "#3F45B8", tint: "#E3E4FA", ink: "#2F35A0" },
};
export const COLOUR_NAMES = Object.keys(COLOURS);
export const tintVars = (a?: { colour: string }): CSSProperties =>
  a ? ({ "--tint": COLOURS[a.colour]?.tint, "--nm": COLOURS[a.colour]?.ink } as CSSProperties) : {};
export const lookSrc = (style: string, colour: string) => `/avatars/set/${style}-${colour}.png`;

const PERSON_TONES = [
  { bg: "#E9E4DA", fg: "#5A4F3F" },
  { bg: "#DDE8F0", fg: "#3C5566" },
  { bg: "#E6E1F2", fg: "#4F4570" },
  { bg: "#E3EEE2", fg: "#3E5A3B" },
  { bg: "#F2E2E2", fg: "#6B3E3E" },
];
const toneFor = (id: string) => PERSON_TONES[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % PERSON_TONES.length];

// ---------------------------------------------------------------- status
export type Vis = "working" | "blocked" | "waiting" | "idle" | "sleeping";
export function vis(s?: AgentStatus): Vis {
  switch (s?.state) {
    case "working":
    case "starting":
      return "working";
    case "waiting_approval":
      return "waiting";
    case "crashed":
    case "budget":
      return "blocked";
    case "idle":
      return "idle";
    default:
      return "sleeping";
  }
}
/** A live "Working" mark for a task card while its agent is busy in the task's chat. */
export function WorkingMark({ a, chatId, done }: { a?: Agent; chatId: string; done?: boolean }) {
  if (done || !a || vis(a.status) !== "working" || (a.status.chatId && a.status.chatId !== chatId)) return null;
  return (
    <span className="working-mark" title={a.status.detail || "Working"}>
      <i />
      Working
    </span>
  );
}

export function statusLabel(s?: AgentStatus): string {
  switch (s?.state) {
    case "working":
      return "Working";
    case "starting":
      return "Waking up";
    case "waiting_approval":
      return "Waiting for you";
    case "crashed":
      return "Stuck";
    case "budget":
      return "Out of budget";
    case "stopped":
      return "Paused";
    default:
      // idle or asleep: either way it answers the moment you write
      return "Ready";
  }
}
const STATUS_ICON: Record<Vis, string> = { working: "refresh", waiting: "shield", blocked: "alert", idle: "check", sleeping: "check" };
export function StatusPill({ s, text }: { s?: AgentStatus; text?: string }) {
  const v = vis(s);
  return (
    <span className={`status ${v}`}>
      <Icon n={STATUS_ICON[v]} />
      {text ?? statusLabel(s)}
    </span>
  );
}

// ---------------------------------------------------------------- avatars
export function Blob(props: { style: string; colour: string; size?: number; state?: Vis; dot?: boolean; title?: string; onClick?: () => void; className?: string }) {
  const { size = 40, state = "idle", dot = false } = props;
  return (
    <span
      className={`av is-agent st-${state} ${props.onClick ? "click" : ""} ${props.className ?? ""}`}
      style={size ? ({ "--s": `${size}px` } as CSSProperties) : undefined}
      title={props.title}
      onClick={props.onClick}
    >
      <img src={lookSrc(props.style, props.colour)} alt={props.title ?? ""} draggable={false} />
      {dot && <i className="av-dot" />}
    </span>
  );
}
export function AgentAv({ a, size = 40, dot = true, onClick }: { a?: Agent; size?: number; dot?: boolean; onClick?: () => void }) {
  if (!a) return <PersonAv name="?" id="x" size={size} />;
  return <Blob style={a.style} colour={a.colour} size={size} state={vis(a.status)} dot={dot} title={`${a.name}${a.roleTitle ? ", " + a.roleTitle : ""}`} onClick={onClick} />;
}
export function PersonAv({ name, id, size = 40, dot = false }: { name: string; id: string; size?: number; dot?: boolean }) {
  const t = toneFor(id);
  return (
    <span className="av is-person" style={size ? ({ "--s": `${size}px` } as CSSProperties) : undefined} title={name}>
      <span className="av-person" style={{ background: t.bg, color: t.fg }}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
      {dot && <i className="av-dot" />}
    </span>
  );
}
export function UserAv({ u, size = 40, dot = false }: { u?: User; size?: number; dot?: boolean }) {
  return <PersonAv name={u?.name ?? "?"} id={u?.id ?? "?"} size={size} dot={dot} />;
}
/** Any chat member: agents as blobs, people as initials. */
export function MemberAv({ m, size = 40, dot = false, onClick }: { m: Member; size?: number; dot?: boolean; onClick?: () => void }) {
  const { agent, user } = useStore();
  return m.type === "agent" ? <AgentAv a={agent(m.id)} size={size} dot={dot} onClick={onClick} /> : <UserAv u={user(m.id)} size={size} dot={dot} />;
}
/** Up to three blobs for a group. */
export function Cluster({ members, size = 48 }: { members: Member[]; size?: number }) {
  const { me } = useStore();
  const agentsFirst = [...members.filter((m) => m.type === "agent"), ...members.filter((m) => m.type === "user" && m.id !== me.id)].slice(0, 3);
  if (agentsFirst.length === 0) return <PersonAv name="#" id="group" size={size} />;
  if (agentsFirst.length === 1) return <MemberAv m={agentsFirst[0]} size={size} />;
  return (
    <div className="cluster" style={{ "--cs": `${size}px` } as CSSProperties}>
      {agentsFirst.map((m) => (
        <MemberAv key={m.type + m.id} m={m} size={0} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- controls
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" className={"toggle" + (on ? " on" : "")} disabled={disabled} aria-pressed={on} aria-label={label} onClick={() => onChange(!on)} />;
}
export function Seg<T extends string>({ value, options, onChange, full }: { value: T; options: [T, string][]; onChange: (v: T) => void; full?: boolean }) {
  return (
    <div className="seg" style={full ? { width: "100%", display: "flex", background: "var(--sunk)" } : undefined} role="radiogroup">
      {options.map(([v, label]) => (
        <span key={v} role="radio" aria-checked={v === value} className={(v === value ? "on" : "") + (full ? " grow" : "")} style={full ? { textAlign: "center" } : undefined} onClick={() => onChange(v)}>
          {label}
        </span>
      ))}
    </div>
  );
}
export function Filters<T extends string>({ value, options, onChange, style }: { value: T; options: [T, string][]; onChange: (v: T) => void; style?: CSSProperties }) {
  return (
    <div className="filters" style={style}>
      {options.map(([v, label]) => (
        <span key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </span>
      ))}
    </div>
  );
}
export type Decision = "allow" | "ask" | "block" | "off";
export function Tri({ value, onChange, withOff }: { value: Decision; onChange: (d: Decision) => void; withOff?: boolean }) {
  const opts: [Decision, string, string][] = [
    ["allow", "Allow", "a"],
    ["ask", "Ask", "k"],
    ["block", "Block", "b"],
  ];
  if (withOff) opts.push(["off", "Off", "o"]);
  return (
    <span className="tri">
      {opts.map(([d, label, c]) => (
        <span key={d} className={value === d ? `on ${c}` : ""} onClick={() => onChange(d)}>
          {label}
        </span>
      ))}
    </span>
  );
}
export function Swatch({ c, on, size = 30, onClick }: { c: string; on: boolean; size?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      title={c}
      aria-label={c}
      className="swatch"
      onClick={onClick}
      style={{
        width: size,
        height: size,
        background: COLOURS[c].hex,
        boxShadow: "inset 0 -3px 6px rgba(0,0,0,.12)" + (on ? ",0 0 0 2px #fff,0 0 0 4px var(--ink)" : ""),
      }}
    />
  );
}

export function Modal(props: { title: ReactNode; sub?: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props.onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={props.width ? { width: props.width } : undefined}>
        <div className="modal-h">
          {props.icon}
          <div className="grow">
            <b>{props.title}</b>
            {props.sub && <div className="small muted">{props.sub}</div>}
          </div>
          <button className="btn icon ghost" aria-label="Close" onClick={props.onClose}>
            <Icon n="x" />
          </button>
        </div>
        <div className="modal-b">{props.children}</div>
        {props.footer && <div className="modal-f">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon n={icon} />
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- formatting
const pad = (n: number) => String(n).padStart(2, "0");
export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function shortWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(ts);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yest.";
  if (now.getTime() - ts < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today ${hhmm(ts)}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${hhmm(ts)}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${hhmm(ts)}`;
}
export function ago(ts: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const dollars = (micros: number) => `$${(micros / 1e6).toFixed(micros > 0 && micros < 10_000 ? 4 : 2)}`;
export const AUTONOMY: [Agent["autonomy"], string][] = [
  ["ask", "Asks first"],
  ["act", "Does it, then tells me"],
  ["auto", "Fully on its own"],
];
export const ENGINE_TONE: Record<string, { bg: string; fg: string; l: string }> = {
  hermes: { bg: "#EDE6FF", fg: "#5B3FC4", l: "H" },
  openclaw: { bg: "#FFE7E2", fg: "#B0401F", l: "O" },
  claude: { bg: "#FFF0E0", fg: "#A35A0E", l: "C" },
  codex: { bg: "#E3F5EA", fg: "#178A4C", l: "X" },
  gemini: { bg: "#E6EFFF", fg: "#2556B8", l: "G" },
  goose: { bg: "#F1F2F6", fg: "#4A4D5C", l: "g" },
  opencode: { bg: "#F1F2F6", fg: "#4A4D5C", l: "oc" },
  mock: { bg: "#F1F2F6", fg: "#4A4D5C", l: "T" },
  "mock-gw": { bg: "#F1F2F6", fg: "#4A4D5C", l: "T" },
};
const ENGINE_LOGO: Record<string, string> = {
  hermes: "/engines/hermes-agent.webp",
  openclaw: "/engines/openclaw.svg",
  claude: "/engines/claude.svg",
  codex: "/engines/codex.svg",
  gemini: "/engines/gemini-cli.webp",
  goose: "/engines/goose-app.webp",
  opencode: "/engines/opencode.webp",
};
export function EngIcon({ id, size = 44 }: { id: string; size?: number }) {
  const t = ENGINE_TONE[id] ?? { bg: "#F1F2F6", fg: "#4A4D5C", l: id.slice(0, 1).toUpperCase() };
  const logo = ENGINE_LOGO[id];
  if (logo)
    return (
      <span className="ic eng logo" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
        <img src={logo} alt="" width={Math.round(size * 0.7)} height={Math.round(size * 0.7)} />
      </span>
    );
  return (
    <span className="ic eng" style={{ width: size, height: size, borderRadius: size * 0.3, fontSize: size * 0.36, background: t.bg, color: t.fg }}>
      {t.l}
    </span>
  );
}
/** Render @mentions in bold. */
export function withMentions(text: string): ReactNode[] {
  const parts = text.split(/((?:^|(?<=[^\w@]))@[a-z][a-z0-9_-]{1,30})/gi);
  return parts.map((p, i) => (/^@[a-z]/i.test(p) ? <span key={i} className="mention">{p}</span> : p));
}
