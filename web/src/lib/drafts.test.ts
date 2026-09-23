import { beforeEach, describe, expect, it } from "vitest";

// The drafts module reads the bare `localStorage` global. In a node test env
// there is none, so install a minimal in-memory one before importing it.
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as unknown as Storage;
}
(globalThis as { localStorage?: Storage }).localStorage = memStorage();

const { clearDraft, loadDraft, saveDraft } = await import("./drafts");

beforeEach(() => {
  localStorage.clear();
});

describe("composer drafts", () => {
  it("round-trips a draft per scope", () => {
    saveDraft("c1", "hello there");
    expect(loadDraft("c1")?.body).toBe("hello there");
  });

  it("keeps scopes isolated", () => {
    saveDraft("c1", "channel draft");
    saveDraft("thread:99", "thread draft");
    expect(loadDraft("c1")?.body).toBe("channel draft");
    expect(loadDraft("thread:99")?.body).toBe("thread draft");
  });

  it("emptying the composer clears the stored draft", () => {
    saveDraft("c1", "wip");
    saveDraft("c1", "");
    expect(loadDraft("c1")).toBeNull();
  });

  it("clearDraft removes the entry", () => {
    saveDraft("c1", "sent? no, wiped");
    clearDraft("c1");
    expect(loadDraft("c1")).toBeNull();
  });

  it("loadDraft ignores malformed storage instead of throwing", () => {
    localStorage.setItem("cc:draft:c1", "{not json");
    expect(loadDraft("c1")).toBeNull();
    localStorage.setItem("cc:draft:c2", JSON.stringify({ body: 42 }));
    expect(loadDraft("c2")).toBeNull();
  });

  it("survives a storage that throws on setItem (private mode)", () => {
    const real = localStorage;
    (globalThis as { localStorage: Storage }).localStorage = {
      ...memStorage(),
      setItem: () => { throw new Error("QuotaExceeded"); },
    } as Storage;
    expect(() => saveDraft("c1", "boom")).not.toThrow();
    (globalThis as { localStorage: Storage }).localStorage = real;
  });
});

describe("clearAllDrafts", () => {
  it("removes only draft keys", async () => {
    const { clearAllDrafts } = await import("./drafts");
    const store = new Map<string, string>();
    (globalThis as { localStorage: Storage }).localStorage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    } as Storage;
    saveDraft("c1", "a");
    saveDraft("thread:m1", "b");
    localStorage.setItem("cc:other", "keep");
    clearAllDrafts();
    expect(loadDraft("c1")).toBeNull();
    expect(loadDraft("thread:m1")).toBeNull();
    expect(localStorage.getItem("cc:other")).toBe("keep");
  });
});
