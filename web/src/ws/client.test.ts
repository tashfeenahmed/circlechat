// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The EventBus in src/ws/client.ts drives live updates for the whole app and
// the server replays nothing missed while a socket was down, so a RECONNECT
// must tell listeners to refetch. These tests pin the protocol with a fake
// WebSocket: first open = no resync, dropped + reopened = exactly one
// bus.resync to every listener, manual disconnect() then reconnect = no
// resync (a fresh identity already loaded via REST).

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  sent: string[] = []
  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.onclose?.()
  }
  open() {
    this.onopen?.()
  }
  drop() {
    // simulate the network dropping an established socket
    this.readyState = 3
    this.onclose?.()
  }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadBus() {
  // Fresh module per test: the bus is a singleton with connection state.
  vi.resetModules()
  const mod = await import('./client')
  return mod.bus as {
    connect: () => void
    disconnect: () => void
    on: (fn: (ev: Record<string, unknown>) => void) => () => void
  }
}

function lastSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
}

describe('bus resync protocol', () => {
  it('first open does not fire bus.resync', async () => {
    const bus = await loadBus()
    const events: string[] = []
    bus.on((ev) => events.push(String(ev.type)))
    bus.connect()
    lastSocket().open()
    expect(events).toEqual([])
  })

  it('a reconnect after an unclean close fires exactly one bus.resync', async () => {
    vi.useFakeTimers()
    const bus = await loadBus()
    const events: string[] = []
    bus.on((ev) => events.push(String(ev.type)))
    bus.connect()
    lastSocket().open()
    lastSocket().drop()
    // backoff starts at 500ms before the retry connect
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances.length).toBe(2)
    lastSocket().open()
    expect(events.filter((e) => e === 'bus.resync')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('a manual disconnect followed by connect is NOT a reconnect', async () => {
    const bus = await loadBus()
    const events: string[] = []
    bus.on((ev) => events.push(String(ev.type)))
    bus.connect()
    lastSocket().open()
    bus.disconnect()
    bus.connect()
    lastSocket().open()
    expect(events.filter((e) => e === 'bus.resync')).toHaveLength(0)
  })

  it('one throwing listener does not stop the others from resyncing', async () => {
    vi.useFakeTimers()
    const bus = await loadBus()
    const seen: string[] = []
    bus.on(() => {
      throw new Error('boom')
    })
    bus.on((ev) => seen.push(String(ev.type)))
    bus.connect()
    lastSocket().open()
    lastSocket().drop()
    await vi.advanceTimersByTimeAsync(1000)
    lastSocket().open()
    expect(seen).toContain('bus.resync')
    vi.useRealTimers()
  })
})
