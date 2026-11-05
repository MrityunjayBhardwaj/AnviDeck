// Design's Ask before writing, driven through the screen's own DOM code (#87): what Start agent
// sends is exactly the folder and prompt the confirm panel showed, and an empty box sends nothing.
// The test runner has no DOM, so a small fake one stands in: enough for the elements, clicks and
// properties DesignScreen uses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

class FakeNode {
  parent: FakeEl | null = null;
  constructor(public text = "") {}
  get textContent(): string {
    return this.text;
  }
}

class FakeEl extends FakeNode {
  attrs: Record<string, string> = {};
  kids: FakeNode[] = [];
  dataset: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  onclick: ((e?: unknown) => unknown) | null = null;
  value = "";
  disabled = false;
  isConnected = false;
  rel = "";
  href = "";
  className = "";
  constructor(public tagName: string) {
    super();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  get id() {
    return this.attrs.id ?? "";
  }
  get placeholder() {
    return this.attrs.placeholder ?? "";
  }
  get hidden() {
    return "hidden" in this.attrs;
  }
  set hidden(v: boolean) {
    if (v) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  override get textContent(): string {
    return this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    this.kids = [new FakeNode(v)];
  }
  append(...ns: (FakeNode | string)[]) {
    for (const n of ns) {
      const node = typeof n === "string" ? new FakeNode(n) : n;
      node.parent = this;
      this.kids.push(node);
    }
  }
  appendChild(n: FakeNode) {
    this.append(n);
    return n;
  }
  replaceChildren(...ns: (FakeNode | string)[]) {
    this.kids = [];
    this.append(...ns);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  click() {
    if (!this.disabled) return this.onclick?.();
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    for (const k of this.kids)
      if (k instanceof FakeEl) {
        if (pred(k)) return k;
        const f = k.find(pred);
        if (f) return f;
      }
    return null;
  }
  byId(id: string) {
    return this.find((e) => e.id === id);
  }
}

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const posts: { url: string; body: unknown }[] = [];

const STRUCTURE = {
  status: "measured",
  project: "stave",
  package: { dir: "/s/packages/editor", design: "/L/design.json", baseline: "/L/baseline.json", designId: "cffdf7d00026", extractor: null, source: "locked", check: { mode: "refuse" } },
  refChosenBy: "default",
  measuredAt: { ref: "origin/main", sha: "6a5c17c682ad", date: "2026-11-05T17:21:15+05:30" },
  designId: "cffdf7d00026",
  source: { label: "structure-guard" },
  byPair: [],
  counts: { divergence: { grandfathered: 0, new: 0, fixed: 0 }, cycle: { total: 0, new: 0 }, examinedBetweenComponents: 0, edges: 0 },
};

function answer(url: string, method: string, body: unknown): Response {
  if (method === "POST") {
    posts.push({ url, body });
    return new Response(JSON.stringify({ id: "a1", status: "starting" }), { status: 201 });
  }
  if (url.startsWith("/api/structure/")) return Response.json(STRUCTURE);
  if (url.startsWith("/api/project/")) return Response.json({ name: "stave", path: "/Users/x/stave", catalogues: [], boundaries: [] });
  if (url.startsWith("/api/refusals")) return Response.json({ status: "no-design", project: "stave", reason: "none" });
  if (url.startsWith("/api/design/cost")) return Response.json({ status: "no-design", project: "stave", reason: "none" });
  if (url.startsWith("/api/design/hooks")) return Response.json({ readAt: "2026-11-05T12:00:00Z", files: [], hooks: [], notRead: "plugins are not read" });
  return new Response("{}", { status: 404 });
}

beforeAll(() => {
  for (const k of ["document", "fetch", "history"]) saved[k] = g[k];
  const head = new FakeEl("head");
  g.document = {
    head,
    querySelector: () => null,
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
    createTextNode: (s: string) => new FakeNode(s),
  };
  g.history = { replaceState: () => {} };
  g.fetch = (async (u: string, init?: RequestInit) => answer(String(u), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined)) as unknown as typeof fetch;
});
afterAll(() => {
  for (const k of Object.keys(saved)) g[k] = saved[k];
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function screen(): Promise<FakeEl> {
  const { DesignScreen } = await import("../ui/components/DesignScreen");
  const root = DesignScreen("stave", new URLSearchParams("lens=placed")) as unknown as FakeEl;
  await settle();
  return root;
}

describe("Ask before writing, through the screen", () => {
  test("Start agent sends exactly the folder and prompt the panel showed, even if the box changes after", async () => {
    posts.length = 0;
    const root = await screen();
    const q = root.byId("dz-question")!;
    q.value = "Where does a tempo map go?";
    root.byId("dz-ask")!.click();
    const shownPrompt = root.byId("dz-prompt")!.textContent;
    const shownCwd = root.byId("dz-cwd")!.textContent;
    expect(shownPrompt).toContain("Question: Where does a tempo map go?\n");
    expect(shownCwd).toBe("/Users/x/stave");
    q.value = "something typed after the prompt was shown";
    await root.byId("dz-start")!.click();
    await settle();
    expect(posts).toEqual([{ url: "/api/agents", body: { cwd: shownCwd, prompt: shownPrompt } }]);
    expect(root.byId("dz-agent")!.textContent).toBe("a1");
  });

  test("an empty box shows why, offers no Start agent, and never sends the placeholder", async () => {
    posts.length = 0;
    const root = await screen();
    const q = root.byId("dz-question")!;
    q.value = "   ";
    root.byId("dz-ask")!.click();
    expect(root.byId("dz-prompt")).toBeNull();
    expect(root.byId("dz-start")).toBeNull();
    expect(root.byId("dz-ask-empty")!.textContent).toContain("Type a question first");
    expect(root.byId("dz-confirm")!.textContent).not.toContain(q.placeholder);
    expect(posts).toEqual([]);
  });
});
