type Listener = (ev: Record<string, unknown>) => void;

const WS_URL = import.meta.env.VITE_WS_URL ?? "/events";

function wsUrl(): string {
  if (/^wss?:\/\//.test(WS_URL)) return WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WS_URL.startsWith("/") ? WS_URL : "/" + WS_URL}`;
}

class EventBus {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 500;
  // Conversations the UI has asked the server to fan events out for. We
  // remember them so we can replay the subscribe frames whenever the socket
  // (re)opens — a fresh DM opened after connect, or any reconnect, would
  // otherwise stop delivering live events.
  private subscribedConvs = new Set<string>();

  connect(): void {
    // `disconnect()` marks the bus closed so a pending reconnect timer won't
    // resurrect a socket the app tore down. A later connect() is an explicit
    // request to come back — clear the flag, or the bus stays dead for the
    // rest of the session (this happened on every workspace switch: the /me
    // effect cleans up with disconnect(), then re-runs connect(), which was a
    // no-op, so live events silently stopped).
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) return;
    const s = new WebSocket(wsUrl());
    this.ws = s;

    s.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      for (const cid of this.subscribedConvs) {
        try { s.send(JSON.stringify({ type: "subscribe", conversationId: cid })); } catch { /* retry on reconnect */ }
      }
    };
    s.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        for (const l of this.listeners) l(data);
      } catch {
        // ignore non-JSON
      }
    };
    s.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    s.onerror = () => {
      s.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.backoff = Math.min(10_000, this.backoff * 2);
      this.connect();
    }, this.backoff);
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Conversation subscriptions belong to the identity that made them; a
    // reconnect after a workspace switch re-subscribes from the new
    // conversation list, not the old workspace's.
    this.subscribedConvs.clear();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      // Detach handlers so the close of the OLD socket can't schedule a
      // reconnect or clobber a NEW socket opened right after.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  send(obj: Record<string, unknown>): void {
    if (obj.type === "subscribe" && typeof obj.conversationId === "string") {
      this.subscribedConvs.add(obj.conversationId);
    }
    if (this.connected && this.ws) this.ws.send(JSON.stringify(obj));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const bus = new EventBus();
