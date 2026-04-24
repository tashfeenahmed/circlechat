import { create } from "zustand";
import type { DirMember } from "../api/client";

const DETAILS_W_KEY = "cc:detailsW";
const THREAD_W_KEY = "cc:threadW";
const PANE_MIN = 280;
const PANE_MAX = 720;

function readStoredWidth(key: string, fallback: number): number {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(PANE_MAX, Math.max(PANE_MIN, n));
  } catch {
    return fallback;
  }
}

interface PresenceState {
  presence: Record<string, string>; // memberId -> status
  setPresence: (memberId: string, status: string) => void;
  typing: Record<string, Record<string, number>>; // conv -> member -> ts
  touchTyping: (convId: string, memberId: string) => void;
  pruneTyping: () => void;
  agentRuns: Record<
    string,
    { agentId: string; agentName: string | null; agentHandle: string | null; trigger: string; startedAt: number }
  >;
  // Transient list of recent run failures (reply-guard rejects, etc.) that
  // the UI surfaces for a few seconds so users know why nothing posted.
  recentFailures: Array<{
    runId: string;
    agentId: string;
    agentName: string | null;
    agentHandle: string | null;
    conversationId: string | null;
    errors: string[];
    at: number;
  }>;
  addRunFailure: (f: {
    runId: string;
    agentId: string;
    agentName: string | null;
    agentHandle: string | null;
    conversationId: string | null;
    errors: string[];
    at: number;
  }) => void;
  pruneRunFailures: () => void;
  beginRun: (
    runId: string,
    agentId: string,
    trigger: string,
    agentName?: string | null,
    agentHandle?: string | null,
  ) => void;
  endRun: (runId: string) => void;
  syncRuns: (
    runs: Array<{
      runId: string;
      agentId: string;
      agentName: string | null;
      agentHandle: string | null;
      trigger: string;
      startedAt: string;
    }>,
  ) => void;
  pruneStaleRuns: () => void;
  directory: Record<string, DirMember>;
  setDirectory: (all: DirMember[]) => void;
  detailsMemberId: string | null;
  openDetails: (memberId: string) => void;
  closeDetails: () => void;
  threadConvId: string | null;
  threadRootId: string | null;
  openThread: (conversationId: string, messageId: string) => void;
  closeThread: () => void;
  detailsWidth: number;
  threadWidth: number;
  setDetailsWidth: (w: number) => void;
  setThreadWidth: (w: number) => void;
  // File viewer — shown when a user clicks an attachment in chat, a task
  // comment, the Files tab, or a board card. Holds the file being viewed
  // plus an optional list of siblings so the viewer can page through them.
  viewerFile: ViewerFile | null;
  viewerSiblings: ViewerFile[] | null;
  openViewer: (file: ViewerFile, siblings?: ViewerFile[]) => void;
  closeViewer: () => void;
}

export interface ViewerFile {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export const useBus = create<PresenceState>((set, get) => ({
  presence: {},
  typing: {},
  agentRuns: {},
  recentFailures: [],
  directory: {},
  setPresence: (memberId, status) =>
    set((s) => ({ presence: { ...s.presence, [memberId]: status } })),
  touchTyping: (convId, memberId) =>
    set((s) => ({
      typing: {
        ...s.typing,
        [convId]: { ...(s.typing[convId] ?? {}), [memberId]: Date.now() },
      },
    })),
  pruneTyping: () => {
    const now = Date.now();
    const next = { ...get().typing };
    let changed = false;
    for (const [convId, m] of Object.entries(next)) {
      const kept: Record<string, number> = {};
      for (const [mid, t] of Object.entries(m)) {
        if (now - t < 4500) kept[mid] = t;
        else changed = true;
      }
      next[convId] = kept;
    }
    if (changed) set({ typing: next });
  },
  beginRun: (runId, agentId, trigger, agentName = null, agentHandle = null) =>
    set((s) => {
      // Never downgrade a name we already have: if the worker's started
      // event arrives second with fresh values, keep the earlier name if
      // the new one is null.
      const prev = s.agentRuns[runId];
      return {
        agentRuns: {
          ...s.agentRuns,
          [runId]: {
            agentId,
            agentName: agentName ?? prev?.agentName ?? null,
            agentHandle: agentHandle ?? prev?.agentHandle ?? null,
            trigger,
            startedAt: prev?.startedAt ?? Date.now(),
          },
        },
      };
    }),
  endRun: (runId) =>
    set((s) => {
      const n = { ...s.agentRuns };
      delete n[runId];
      return { agentRuns: n };
    }),
  addRunFailure: (f) =>
    set((s) => ({ recentFailures: [...s.recentFailures.filter((x) => x.runId !== f.runId), f].slice(-10) })),
  pruneRunFailures: () => {
    const now = Date.now();
    const next = get().recentFailures.filter((f) => now - f.at < 12_000);
    if (next.length !== get().recentFailures.length) set({ recentFailures: next });
  },
  syncRuns: (runs) =>
    set((s) => {
      // Merge the server-side truth into local state: server wins for runs it
      // still has as "running"; preserve any locally-tracked run that might be
      // <1s ahead of the DB flush. Clock skew is rounded server-side.
      const next = { ...s.agentRuns };
      const seen = new Set<string>();
      for (const r of runs) {
        seen.add(r.runId);
        const startedAt = Date.parse(r.startedAt);
        const prev = next[r.runId];
        next[r.runId] = {
          agentId: r.agentId,
          agentName: r.agentName ?? prev?.agentName ?? null,
          agentHandle: r.agentHandle ?? prev?.agentHandle ?? null,
          trigger: r.trigger,
          startedAt: Number.isFinite(startedAt) ? startedAt : (prev?.startedAt ?? Date.now()),
        };
      }
      // Drop any locally-tracked run that the server no longer reports as
      // running. The finished frame was probably missed during a disconnect.
      for (const runId of Object.keys(next)) {
        if (!seen.has(runId) && !s.agentRuns[runId]?.startedAt) continue;
        if (!seen.has(runId) && Date.now() - next[runId].startedAt > 15_000) {
          delete next[runId];
        }
      }
      return { agentRuns: next };
    }),
  pruneStaleRuns: () => {
    // Agent runs that the client started tracking but for which the matching
    // `agent.run.finished` event was never seen (e.g. because the WS briefly
    // dropped or the bridge's ack got lost). Hermes times out after 180s, so
    // anything older than 210s is definitely stale and shouldn't keep showing
    // the "thinking" pill forever.
    const now = Date.now();
    const next = { ...get().agentRuns };
    let changed = false;
    for (const [runId, meta] of Object.entries(next)) {
      if (now - meta.startedAt > 210_000) {
        delete next[runId];
        changed = true;
      }
    }
    if (changed) set({ agentRuns: next });
  },
  setDirectory: (all) =>
    set(() => {
      const d: Record<string, DirMember> = {};
      for (const m of all) d[m.memberId] = m;
      return { directory: d };
    }),
  detailsMemberId: null,
  openDetails: (memberId) =>
    set({ detailsMemberId: memberId, threadConvId: null, threadRootId: null }),
  closeDetails: () => set({ detailsMemberId: null }),
  threadConvId: null,
  threadRootId: null,
  openThread: (conversationId, messageId) =>
    set({
      threadConvId: conversationId,
      threadRootId: messageId,
      detailsMemberId: null,
    }),
  closeThread: () => set({ threadConvId: null, threadRootId: null }),
  detailsWidth: readStoredWidth(DETAILS_W_KEY, 320),
  threadWidth: readStoredWidth(THREAD_W_KEY, 440),
  setDetailsWidth: (w) => {
    const clamped = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(w)));
    try {
      localStorage.setItem(DETAILS_W_KEY, String(clamped));
    } catch { /* ignore */ }
    set({ detailsWidth: clamped });
  },
  setThreadWidth: (w) => {
    const clamped = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(w)));
    try {
      localStorage.setItem(THREAD_W_KEY, String(clamped));
    } catch { /* ignore */ }
    set({ threadWidth: clamped });
  },
  viewerFile: null,
  viewerSiblings: null,
  openViewer: (file, siblings) =>
    set({ viewerFile: file, viewerSiblings: siblings ?? null }),
  closeViewer: () => set({ viewerFile: null, viewerSiblings: null }),
}));

setInterval(() => useBus.getState().pruneTyping(), 2000);
setInterval(() => useBus.getState().pruneStaleRuns(), 15_000);
setInterval(() => useBus.getState().pruneRunFailures(), 2000);
