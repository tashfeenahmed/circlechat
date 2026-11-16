// SPDX-License-Identifier: AGPL-3.0-only
// A deterministic ACP agent for tests. It speaks real ACP over stdio and real MCP
// to the CircleChat tool gateway, driven by directives in the incoming message:
//   !tool <name> <json>     call a gateway tool, report the result
//   !permission             ask the client for permission (session/request_permission)
//   !slow <ms>              take a while, emitting progress updates
//   !crash                  exit with code 1 mid-turn
//   !usage <cents>          report a usage_update with that cost
//   !say <text>             reply with exactly <text>
//   !silent                 end the turn without a reply
// Anything else: "<name> got: <message>".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";

const NAME = process.env.MOCK_AGENT_NAME || "mock";
const sessions = new Map<string, { mcp: any[]; turns: number; cancelled: boolean }>();
let nextId = 1;
const waiting = new Map<number, (v: any) => void>();

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function update(sessionId: string, u: unknown) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}
// stream word by word, like a real model
function say(sessionId: string, text: string) {
  for (const piece of text.match(/\S+\s*|\s+/g) ?? [text]) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
}
function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((r) => waiting.set(id, r));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callTool(sessionId: string, name: string, args: any): Promise<string> {
  const s = sessions.get(sessionId)!;
  const srv = s.mcp.find((m: any) => m.url) ?? (process.env.MOCK_AGENT_MCP_URL ? { url: process.env.MOCK_AGENT_MCP_URL, headers: [] } : undefined);
  if (!srv) return "no MCP server";
  const client = new Client({ name: "mock-agent", version: "1.0.0" });
  const headers: Record<string, string> = {};
  for (const h of srv.headers ?? []) headers[h.name] = h.value;
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers } });
  await client.connect(transport);
  const tcid = randomUUID();
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: tcid, title: `${name}`, kind: "other", status: "in_progress" });
  try {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => c.text ?? "").join("");
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tcid, status: r.isError ? "failed" : "completed" });
    return (r.isError ? "ERROR: " : "") + text;
  } finally {
    await client.close().catch(() => {});
  }
}

async function onPrompt(id: number, params: any) {
  const sessionId = params.sessionId;
  const s = sessions.get(sessionId);
  if (!s) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown session" } });
  s.turns++;
  s.cancelled = false;
  const full: string = (params.prompt ?? []).map((b: any) => b.text ?? "").join("\n");
  const marker = full.lastIndexOf("<<<MESSAGE>>>");
  const msg = (marker >= 0 ? full.slice(marker + 13) : full).replace(/<<<END>>>[\s\S]*$/, "").trim();
  const body = msg.replace(/^From [^\n]*:\n/, "");
  const lines = body.split("\n").map((l) => l.trim());
  const out: string[] = [];
  let silent = false;
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `reading message (turn ${s.turns})` } });
  for (const line of lines) {
    if (s.cancelled) break;
    if (line.startsWith("!crash")) process.exit(1);
    if (line.startsWith("!silent")) silent = true;
    else if (line.startsWith("!say ")) out.push(line.slice(5));
    else if (line.startsWith("!slow")) {
      const ms = Number(line.split(/\s+/)[1] || 500);
      for (let t = 0; t < ms && !s.cancelled; t += 100) {
        update(sessionId, { sessionUpdate: "plan", entries: [{ content: "thinking slowly", priority: "medium", status: "in_progress" }] });
        await sleep(100);
      }
    } else if (line.startsWith("!usage")) {
      const cents = Number(line.split(/\s+/)[1] || 1);
      update(sessionId, { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cents / 100, currency: "USD" } });
    } else if (line.startsWith("!permission")) {
      const r = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: randomUUID(), title: "rm -rf build/", kind: "delete", status: "pending", rawInput: { command: "rm -rf build/" } },
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      out.push(`permission: ${r?.outcome?.outcome === "selected" ? r.outcome.optionId : "cancelled"}`);
    } else if (line.startsWith("!tool ")) {
      const rest = line.slice(6).trim();
      const sp = rest.indexOf(" ");
      const name = sp < 0 ? rest : rest.slice(0, sp);
      let args = {};
      try {
        args = sp < 0 ? {} : JSON.parse(rest.slice(sp + 1));
      } catch {}
      try {
        out.push(`${name} -> ${await callTool(sessionId, name, args)}`);
      } catch (e) {
        out.push(`${name} -> ERROR: ${(e as Error).message}`);
      }
    }
  }
  if (s.cancelled) return send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
  if (!silent) say(sessionId, out.length ? out.join("\n") : `${NAME} got: ${body.split("\n")[0]}`);
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === undefined && m.id !== undefined) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
      continue;
    }
    switch (m.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
            agentInfo: { name: "mock-agent", version: "1.0.0" },
          },
        });
        break;
      case "session/new": {
        const sid = "s_" + randomUUID().slice(0, 8);
        sessions.set(sid, { mcp: m.params.mcpServers ?? [], turns: 0, cancelled: false });
        send({ jsonrpc: "2.0", id: m.id, result: { sessionId: sid } });
        break;
      }
      case "session/load":
        sessions.set(m.params.sessionId, { mcp: m.params.mcpServers ?? [], turns: 0, cancelled: false });
        send({ jsonrpc: "2.0", id: m.id, result: {} });
        break;
      case "session/prompt":
        void onPrompt(m.id, m.params);
        break;
      case "session/cancel": {
        const s = sessions.get(m.params.sessionId);
        if (s) s.cancelled = true;
        break;
      }
      default:
        if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
process.stderr.write(`mock agent ${NAME} ready\n`);
