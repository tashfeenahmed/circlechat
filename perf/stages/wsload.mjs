// WS throughput stage. Opens C subscriber sockets on one channel, posts M
// messages, and measures total delivered events/sec (fan-out amplification).
//
// HONEST SCOPE: this is a single-box, single-poster, scaled-down proxy for
// §16's ">50,000 msgs/sec/core" budget — it will NOT hit 50k from one CI poster
// and a handful of connections. It produces a stable, regression-trackable
// throughput number; treat the absolute 50k budget as aspirational until a real
// multi-node load generator (k6/autocannon) is wired up. Reported, not gated.
import WebSocket from "ws";
import { round, sleep, waitFor } from "../lib/util.mjs";

const BASE = (process.env.PERF_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const CONNS = Number(process.env.PERF_WS_CONNS || 25);
const MSGS = Number(process.env.PERF_WS_MSGS || 200);

function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cc = all.find((c) => c.startsWith("cc_session="));
  return cc ? cc.split(";")[0] : null;
}

export async function runWsload() {
  const metrics = {};
  const notes = [];

  let cookie, convId;
  try {
    const res = await fetch(`${API}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `perfws_${Date.now()}_${Math.floor(Math.random() * 1e6)}@perf.local`,
        password: "perftest12345",
        name: "Perf WS",
        handle: `perfw${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
        workspaceName: "Perf WS Load",
      }),
    });
    if (!res.ok) throw new Error(`signup ${res.status}`);
    cookie = cookieFrom(res);
    const convs = await (await fetch(`${API}/conversations`, { headers: { cookie } })).json();
    const list = Array.isArray(convs) ? convs : convs.conversations || convs.items || [];
    convId = (list.find((c) => c.kind === "channel") || list[0])?.id;
    if (!cookie || !convId) throw new Error("seed incomplete");
  } catch (e) {
    return { metrics, notes: [`wsload: SKIPPED — seed failed (${e.message})`] };
  }

  const wsBase = BASE.replace(/^http/, "ws");
  const sockets = [];
  let delivered = 0;
  try {
    for (let i = 0; i < CONNS; i++) {
      const ws = new WebSocket(`${wsBase}/events`, { headers: { cookie } });
      ws.on("message", (d) => {
        if (d.toString().includes("message.new")) delivered++;
      });
      sockets.push(ws);
    }
    await waitFor(() => sockets.every((s) => s.readyState === 1), {
      timeoutMs: 20000,
      intervalMs: 250,
      label: "all ws open",
    });
  } catch (e) {
    sockets.forEach((s) => s.close());
    return { metrics, notes: [`wsload: SKIPPED — could not open ${CONNS} sockets (${e.message})`] };
  }

  async function post(n) {
    await fetch(`${API}/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ bodyMd: `load ${n}` }),
    }).catch(() => {});
  }

  const t0 = performance.now();
  // Fire in small concurrent batches to push the fan-out without overwhelming
  // the single poster's event loop.
  const BATCH = 10;
  for (let i = 0; i < MSGS; i += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, MSGS - i) }, (_, k) => post(i + k)));
  }
  // Drain: wait until delivery plateaus.
  let last = -1;
  for (let i = 0; i < 20 && delivered !== last; i++) {
    last = delivered;
    await sleep(500);
  }
  const elapsedSec = (performance.now() - t0) / 1000;
  sockets.forEach((s) => s.close());

  const expected = MSGS * CONNS;
  metrics.ws_throughput_msgs_per_sec = round(delivered / elapsedSec, 0);
  notes.push(
    `wsload: ${delivered}/${expected} events delivered across ${CONNS} conns in ${round(elapsedSec, 2)}s (scaled proxy, not the 50k/core budget)`,
  );
  return { metrics, notes };
}
