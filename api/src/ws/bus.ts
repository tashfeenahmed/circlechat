import { sub } from "../lib/redis.js";
import { scrubPublicEvent } from "../lib/public-text.js";
import type { WebSocket } from "ws";

type Client = WebSocket;
const channelToClients = new Map<string, Set<Client>>();
const clientToChannels = new WeakMap<Client, Set<string>>();
// Sockets riding the anonymous spectator identity. They get the public copy of
// every broadcast body — the same text GET /conversations/:id/messages serves
// them — so an open tab can't read what the REST endpoint redacts.
const spectatorClients = new WeakSet<Client>();

export function markSpectator(ws: Client): void {
  spectatorClients.add(ws);
}

let initialized = false;
function init(): void {
  if (initialized) return;
  initialized = true;
  sub.on("message", (channel, message) => {
    const set = channelToClients.get(channel);
    if (!set) return;
    // Scrubbed at most once per frame, and only when a spectator is actually
    // subscribed to this channel — a members-only room pays nothing.
    let publicFrame: string | null = null;
    for (const ws of set) {
      try {
        if (spectatorClients.has(ws)) {
          if (publicFrame === null) publicFrame = scrubPublicEvent(message);
          ws.send(publicFrame);
        } else {
          ws.send(message);
        }
      } catch {
        // drop silently
      }
    }
  });
}

export async function subscribe(ws: Client, channel: string): Promise<void> {
  init();
  let set = channelToClients.get(channel);
  if (!set) {
    set = new Set();
    channelToClients.set(channel, set);
    await sub.subscribe(channel);
  }
  set.add(ws);

  let cset = clientToChannels.get(ws);
  if (!cset) {
    cset = new Set();
    clientToChannels.set(ws, cset);
  }
  cset.add(channel);
}

export async function unsubscribeAll(ws: Client): Promise<void> {
  const cset = clientToChannels.get(ws);
  if (!cset) return;
  for (const ch of cset) {
    const set = channelToClients.get(ch);
    if (!set) continue;
    set.delete(ws);
    if (set.size === 0) {
      channelToClients.delete(ch);
      try {
        await sub.unsubscribe(ch);
      } catch {
        // ignore
      }
    }
  }
  clientToChannels.delete(ws);
}
