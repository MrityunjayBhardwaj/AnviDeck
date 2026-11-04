// The workspace frame (#80): every screen has a URL, is on the rail (or a rail item's tabs, or
// Older views, or Help) and in the palette; placeholders name their issue; the strip and the
// guards pill say only what is real.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OLDER_VIEWS, PROJECT_TABS, RAIL, SCREENS, hashFor, parseRoute, screen, type ScreenId } from "../ui/shell/routes";
import { activityCounts, activityText, activityTitle, type StripAgent } from "../ui/shell/activity";
import { GUARDS, guardsLabel } from "../ui/shell/guards";
import { filterEntries, fuzzyScore, initialSelection, paletteEntries, screenHash, type PaletteInput } from "../ui/shell/palette-model";

const agent = (id: string, status: string, pending = 0): StripAgent => ({
  id,
  status,
  cwd: "/tmp/x",
  prompt: `prompt ${id}\nsecond line`,
  pendingPermissions: Array.from({ length: pending }, (_, i) => ({ requestId: `${id}-${i}` })),
});

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  projects: [
    { name: "alpha", path: "/p/alpha" },
    { name: "beta", path: "" },
  ],
  currentProject: "alpha",
  hostAgents: [agent("a1", "working")],
  terminalAgents: [{ sessionId: "s-1", name: "fix the thing", project: "beta", status: "busy" }],
  ...over,
});

describe("routes", () => {
  test("every screen's hash parses back to that screen, with its params", () => {
    for (const s of SCREENS) {
      expect(parseRoute(hashFor(s.id)).screen).toBe(s.id);
      const r = parseRoute(hashFor(s.id, { project: "p q", name: "n" }));
      expect(r.screen).toBe(s.id);
      expect(r.params.get("project")).toBe("p q");
      expect(r.unknown).toBeUndefined();
    }
  });

  test("empty hash is Home; the prototype's and Home's own hashes still open their screens", () => {
    expect(parseRoute("").screen).toBe("home");
    expect(parseRoute("#").screen).toBe("home");
    expect(parseRoute("#knowledge").screen).toBe("notes");
    expect(parseRoute("#architecture").screen).toBe("design");
    expect(parseRoute("#status").screen).toBe("home");
    expect(parseRoute("#agents?project=x&sid=y").params.get("sid")).toBe("y");
    expect(parseRoute("#map?project=stave&zoom=files").screen).toBe("map");
  });

  test("an unknown hash shows Home and says which name it did not know", () => {
    const r = parseRoute("#nope?x=1");
    expect(r.screen).toBe("home");
    expect(r.unknown).toBe("nope");
    expect(r.params.toString()).toBe("");
  });

  test("every screen is reachable from the frame: a rail item, a Project tab, Older views or Help", () => {
    const railTargets = new Set<ScreenId>(RAIL.map((r) => r.to));
    for (const s of SCREENS) {
      const reachable =
        railTargets.has(s.id) ||
        (s.group === "project" && PROJECT_TABS.includes(s.id) && RAIL.some((r) => r.key === "project")) ||
        (s.group === "older" && OLDER_VIEWS.includes(s.id) && railTargets.has("older")) ||
        (s.group === "help" && s.id === "flows");
      expect({ id: s.id, reachable }).toEqual({ id: s.id, reachable: true });
      // A screen lights the rail item it is reached from.
      if (s.group === "project") expect(s.rail).toBe("project");
      if (s.group === "older") expect(s.rail).toBe("older");
    }
  });

  test("the rail is the prototype's: Home, Map, Agents, Changes, Notes, Project, then Older", () => {
    expect(RAIL.map((r) => r.label)).toEqual(["Home", "Map", "Agents", "Changes", "Notes", "Project", "Older"]);
    expect(PROJECT_TABS).toEqual(["design", "code", "work", "history"]);
  });

  test("screens not built yet name the issue that builds them", () => {
    const builds = Object.fromEntries(SCREENS.filter((s) => s.buildsIn).map((s) => [s.id, s.buildsIn]));
    expect(builds).toEqual({ changes: 84, notes: 89, design: 87, code: 88, work: 85, history: 90, flows: 91 });
    // Screens that exist today are not placeholders.
    for (const id of ["home", "map", "agents", ...OLDER_VIEWS] as ScreenId[]) expect(screen(id).buildsIn).toBeUndefined();
  });

  test("today's views all stay reachable until #92", () => {
    expect([...OLDER_VIEWS].sort()).toEqual(["brain", "cross-project", "github-trace", "project", "routing", "sessions", "system-lens", "trace"]);
    for (const id of OLDER_VIEWS) expect(screen(id).fate).toBeTruthy();
  });

  test("app.ts mounts every built screen and draws a placeholder for the rest", () => {
    const app = readFileSync("ui/app.ts", "utf8");
    for (const s of SCREENS) {
      if (s.buildsIn) continue;
      expect({ id: s.id, mounted: app.includes(`id === "${s.id}"`) }).toEqual({ id: s.id, mounted: true });
    }
    expect(app).toContain("if (def.buildsIn)");
    expect(app).toContain('window.addEventListener("hashchange"');
  });
});

describe("activity strip", () => {
  test("counts by status; waiting on you is agents with a parked permission request", () => {
    const agents = [agent("a", "working"), agent("b", "starting"), agent("c", "waiting", 2), agent("d", "done"), agent("e", "stopped")];
    expect(activityCounts(agents)).toEqual({ total: 5, working: 2, waiting: 1 });
    expect(activityText({ state: "ok", agents })).toBe("5 agents · 2 working · 1 waiting on you");
    expect(activityText({ state: "ok", agents: [agent("a", "working")] })).toBe("1 agent · 1 working · 0 waiting on you");
    expect(activityTitle({ state: "ok", agents })).toContain("#77");
  });

  test("could not look never reads as no agents", () => {
    for (const read of [{ state: "loading" as const }, { state: "off" as const, reason: "registry broken" }, { state: "failed" as const, reason: "500" }]) {
      expect(activityText(read)).not.toMatch(/\d/);
    }
    expect(activityTitle({ state: "off", reason: "registry broken" })).toContain("registry broken");
  });
});

describe("guards indicator", () => {
  test("says Guards on only when every listed guard is on", () => {
    expect(guardsLabel(GUARDS).text).toBe("Guards on");
    expect(guardsLabel(GUARDS).state).toBe("on");
    expect(guardsLabel(GUARDS.map((g, i) => ({ ...g, on: i !== 0 })))).toEqual({ text: "Guards: 3 of 4 on", state: "partial" });
    expect(guardsLabel(GUARDS.map((g) => ({ ...g, on: true })))).toEqual({ text: "Guards on", state: "on" });
  });

  test("the guards it calls on exist in the server code it names", () => {
    for (const g of GUARDS.filter((x) => x.on)) {
      expect(g.code).toBeDefined();
      expect(readFileSync(g.code!.file, "utf8")).toContain(g.code!.has);
    }
    for (const g of GUARDS.filter((x) => !x.on)) expect(g.where).toMatch(/#\d+/);
  });
});

describe("palette", () => {
  test("lists every screen, every project, both kinds of agent, issues and commands", () => {
    const e = paletteEntries(input());
    const screens = e.filter((x) => x.group === "Screens");
    expect(screens.length).toBe(SCREENS.length);
    for (const s of SCREENS) expect(screens.some((x) => x.hash && parseRoute(x.hash).screen === s.id)).toBe(true);
    expect(e.filter((x) => x.group === "Projects").map((x) => x.project)).toEqual(["alpha", "beta"]);
    const agents = e.filter((x) => x.group === "Agents");
    expect(agents.map((x) => x.label)).toEqual(["a1 · prompt a1", "beta · fix the thing"]);
    expect(agents[1].hash).toBe("#agents?project=beta&sid=s-1");
    expect(e.some((x) => x.group === "Issues")).toBe(true);
    expect(e.some((x) => x.group === "Commands" && x.label.startsWith("/anvi:debug"))).toBe(true);
  });

  test("this PR makes no write requests: commands that act are pending, never runnable", () => {
    const e = paletteEntries(input());
    for (const x of e.filter((x) => /start|\/anvi:/i.test(x.label))) {
      expect(x.pending).toBe("#78");
      expect(x.hash ?? x.href ?? x.project).toBeUndefined();
    }
    // Issues: no route lists a project's open issues yet, so it is pending, not an empty list.
    const issues = e.filter((x) => x.group === "Issues");
    expect(issues).toHaveLength(1);
    expect(issues[0].pending).toBeTruthy();
  });

  test("agents that could not be read are left out, not listed as none", () => {
    const e = paletteEntries(input({ hostAgents: null, terminalAgents: [] }));
    expect(e.filter((x) => x.group === "Agents")).toEqual([]);
  });

  test("screens that show one project carry the current project", () => {
    expect(screenHash("project", "alpha")).toBe("#project?name=alpha");
    expect(screenHash("brain", "alpha")).toBe("#brain?project=alpha");
    expect(screenHash("agents", "alpha")).toBe("#agents?project=alpha");
    expect(screenHash("map", "alpha")).toBe("#map");
    expect(screenHash("project", null)).toBe("#project");
  });

  test("fuzzy filter: characters in order, word starts and runs rank first", () => {
    expect(fuzzyScore("hme", "Home")).not.toBeNull();
    expect(fuzzyScore("emo", "Home")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    const e = paletteEntries(input());
    const top = (q: string) => filterEntries(e, q)[0]?.label;
    expect(top("notes")).toBe("Notes");
    expect(top("pd")).toBe("Project · Design");
    expect(top("hist")).toBe("Project · History");
    expect(top("cross")).toBe("Cross-Project");
    expect(filterEntries(e, "zzzzqqq")).toEqual([]);
    // A long path in a hint must not fuzzy-match a command's name: "debug" is the command only,
    // so Enter cannot switch project by accident (seen in the browser before this rule).
    const withPaths = paletteEntries(input({ projects: [{ name: "pkg", path: "/private/tmp/d-e-b-u-g/x" }] }));
    expect(filterEntries(withPaths, "debug").map((x) => x.group)).toEqual(["Commands"]);
    // A hint still lets an entry in when it contains the query as written.
    expect(filterEntries(withPaths, "/private/tmp").map((x) => x.label)).toEqual(["Switch to pkg"]);
    // Each group's rows stay together (never interleaved), whatever the scores.
    const groups = filterEntries(e, "a").map((x) => x.group);
    const runs = groups.filter((g, i) => i === 0 || groups[i - 1] !== g);
    expect(new Set(runs).size).toBe(runs.length);
  });
});

describe("review follow-ups: the palette's first row and hashes that must not crash", () => {
  // Real store names are long dashed paths; their letters spell almost any query when scattered.
  const realName = "-private-tmp-claude-501--Users-someone-Documents-projects-anvi-826675c1-d0e1-4b2a-9c3d-scratchpad-720-run-pkg";
  const realInput: PaletteInput = {
    projects: [{ name: realName, path: "/private/tmp/x" }, { name: "stave", path: "/p/stave" }],
    currentProject: "stave",
    hostAgents: [],
    terminalAgents: [],
  };

  test("'debug' selects the debug command, not a project whose long name scatters the letters", () => {
    const rows = filterEntries(paletteEntries(realInput), "debug");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.group).toBe("Commands");
    expect(rows[0]!.label.toLowerCase()).toContain("debug");
    // The debug command is pending until #78, so nothing is selected and Enter runs nothing.
    expect(rows[0]!.pending).toBeTruthy();
    expect(initialSelection(rows, "debug")).toBe(-1);
    expect(initialSelection(filterEntries(paletteEntries(realInput), "notes"), "notes")).toBe(0);
    expect(initialSelection([], "x")).toBe(-1);
  });

  test("with no query the groups keep their order", () => {
    const rows = filterEntries(paletteEntries(realInput), "");
    expect(rows[0]!.group).toBe("Screens");
  });

  test("a malformed escape in the hash is an unknown screen, not an exception", () => {
    for (const h of ["#%E0", "#map%", "#%"]) {
      const r = parseRoute(h);
      expect(r.screen).toBe("home");
      expect(r.unknown).toBeDefined();
    }
  });

  test("Object.prototype names are not screens", () => {
    for (const h of ["#constructor", "#toString", "#__proto__", "#hasOwnProperty"]) {
      const r = parseRoute(h);
      expect(r.screen).toBe("home");
      expect(r.unknown).toBe(h.slice(1));
    }
    expect(parseRoute("#knowledge").screen).toBe("notes");
  });
});
