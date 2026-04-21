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

  connect(): void {
    if (this.ws || this.closed) return;
    const s = new WebSocket(wsUrl());
    this.ws = s;

    s.onopen = () => {
      this.connected = true;
      this.backoff = 500;
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
    this.reconnectTimer = setTimeout(() => {
      this.backoff = Math.min(10_000, this.backoff * 2);
      this.connect();
    }, this.backoff);
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  send(obj: Record<string, unknown>): void {
    if (this.connected && this.ws) this.ws.send(JSON.stringify(obj));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const bus = new EventBus();
