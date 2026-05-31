// Backend latency stage (CI benchmark against an ephemeral stack).
// Seeds a fresh workspace via the real signup API, then measures:
//   - api_post_message p50/p95  : POST /conversations/:id/messages round-trip
//   - ws_fanout p95             : time from POST to receiving message.new on a
//                                 subscribed /events socket (server-side proxy
//                                 for §16's send-to-render budget)
// Fully resilient: any seed/connect failure -> SKIPPED note, never throws.
import WebSocket from "ws";
import { percentile, round, sleep, waitFor } from "../lib/util.mjs";

const BASE = (process.env.PERF_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const N = Number(process.env.PERF_BACKEND_SAMPLES || 60);

function uniqueEmail() {
  return `perf_${Date.now()}_${Math.floor(Math.random() * 1e6)}@perf.local`;
}

function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cc = all.find((c) => c.startsWith("cc_session="));
  return cc ? cc.split(";")[0] : null;
}

async function postMessage(cookie, convId, bodyMd) {
  // Field name tolerance: the API has used both bodyMd and body across history.
  for (const payload of [{ bodyMd }, { body: bodyMd }]) {
    const res = await fetch(`${API}/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res;
    if (res.status !== 400) return res; // a non-validation error won't be fixed by the other field
  }
  return null;
}

export async function runBackend() {
  const metrics = {};
  const notes = [];

  // 1. Stack reachable?
  try {
    await waitFor(
      async () => {
        const r = await fetch(`${API}/me`, { method: "GET" }).catch(() => null);
        return r && (r.ok || r.status === 401); // 401 = up but unauthenticated
      },
      { timeoutMs: 90000, intervalMs: 2000, label: "api up" },
    );
  } catch (e) {
    return { metrics, notes: [`backend: SKIPPED — API not reachable at ${API} (${e.message})`] };
  }

  // 2. Seed a workspace.
  let cookie, convId;
  try {
    const res = await fetch(`${API}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: uniqueEmail(),
        password: "perftest12345",
        name: "Perf Bench",
        workspaceName: "Perf Bench WS",
      }),
    });
    if (!res.ok) throw new Error(`signup ${res.status}`);
    cookie = cookieFrom(res);
    if (!cookie) throw new Error("no cc_session cookie returned");
    const convs = await (await fetch(`${API}/conversations`, { headers: { cookie } })).json();
    const list = Array.isArray(convs) ? convs : convs.conversations || convs.items || [];
    convId = (list.find((c) => c.kind === "channel") || list[0])?.id;
    if (!convId) throw new Error("no conversation found after signup");
  } catch (e) {
    return { metrics, notes: [`backend: SKIPPED — seed failed (${e.message})`] };
  }

  // 3. Connect a subscriber socket for fan-out timing.
  const wsBase = BASE.replace(/^http/, "ws");
  let ws, wsReady = false;
  const pending = new Map(); // nonce -> postTimestamp
  const fanout = [];
  try {
    ws = new WebSocket(`${wsBase}/events`, { headers: { cookie } });
    ws.on("message", (data) => {
      const txt = data.toString();
      for (const [nonce, t0] of pending) {
        if (txt.includes(nonce)) {
          fanout.push(performance.now() - t0);
          pending.delete(nonce);
        }
      }
    });
    await waitFor(() => wsReady || ws.readyState === 1, { timeoutMs: 15000, intervalMs: 250, label: "ws open" });
    wsReady = true;
  } catch (e) {
    notes.push(`backend: ws fan-out skipped — ${e.message}`);
  }

  // 4. Verify message POST works at all before benchmarking.
  const probe = await postMessage(cookie, convId, "perf-probe").catch(() => null);
  if (!probe || !probe.ok) {
    if (ws) ws.close();
    return { metrics, notes: [`backend: SKIPPED — message POST failed (${probe ? probe.status : "no response"})`] };
  }

  // 5. Benchmark.
  const apiLatencies = [];
  for (let i = 0; i < N; i++) {
    const nonce = `perfn-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`;
    const t0 = performance.now();
    if (ws && ws.readyState === 1) pending.set(nonce, t0);
    const res = await postMessage(cookie, convId, `bench ${nonce}`).catch(() => null);
    const dt = performance.now() - t0;
    if (res && res.ok) apiLatencies.push(dt);
    await sleep(15); // keep it sequential and realistic, not a flood
  }
  // Give in-flight fan-out events a moment to land.
  await sleep(1500);
  if (ws) ws.close();

  if (apiLatencies.length) {
    metrics.api_post_message_p50_ms = round(percentile(apiLatencies, 50));
    metrics.api_post_message_p95_ms = round(percentile(apiLatencies, 95));
    notes.push(`backend: ${apiLatencies.length}/${N} POST samples`);
  } else {
    notes.push("backend: no successful POST samples");
  }
  if (fanout.length) {
    metrics.ws_fanout_p95_ms = round(percentile(fanout, 95));
    notes.push(`backend: ${fanout.length} fan-out samples`);
  } else if (wsReady) {
    notes.push("backend: ws connected but received no matching fan-out events");
  }

  return { metrics, notes };
}
