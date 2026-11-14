/**
 * What a terminal Claude Code session edited (#206): server/readers/session-edits.ts reads the edit
 * calls of a session's transcript and its subagents' transcripts, on from where it last stopped.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editCalls, sessionEdits } from "../server/readers/session-edits";

const dirs: string[] = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sess-edits-")));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const call = (name: string, file: string, at = "2026-11-14T10:00:00Z") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t", name, input: name === "NotebookEdit" ? { notebook_path: file } : { file_path: file } }] } }) + "\n";
const other = (n = 0) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(n) }] } }) + "\n";

/** A projects folder with the session's transcript for `cwd`. */
function setup(cwd = "/Users/x/proj") {
  const projects = scratch();
  const sid = "11111111-2222-3333-4444-555555555555";
  const dir = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return { projects, sid, cwd, dir, main: join(dir, `${sid}.jsonl`) };
}

describe("a session's edit calls", () => {
  test("every edit tool, by the path it named; Read, Bash and relative paths are not edits", () => {
    const s = setup();
    writeFileSync(s.main, call("Edit", "/r/a.ts") + call("Write", "/r/b.ts") + call("MultiEdit", "/r/c.ts") + call("NotebookEdit", "/r/d.ipynb") + call("Read", "/r/e.ts") + call("Bash", "/r/f.ts") + call("Edit", "rel/g.ts") + other());
    const r = sessionEdits(s.sid, s.cwd, s.projects);
    expect(r.edits.map((e) => [e.tool, e.abs])).toEqual([["Edit", "/r/a.ts"], ["Write", "/r/b.ts"], ["MultiEdit", "/r/c.ts"], ["NotebookEdit", "/r/d.ipynb"]]);
    expect(r.edits[0].at).toBe("2026-11-14T10:00:00Z");
    expect(r).toEqual(expect.objectContaining({ files: 1 }));
    expect(r.unreadable).toBeUndefined();
  });

  test("its subagents' transcripts count too", () => {
    const s = setup();
    writeFileSync(s.main, other());
    mkdirSync(join(s.dir, s.sid, "subagents"), { recursive: true });
    writeFileSync(join(s.dir, s.sid, "subagents", "agent-1.jsonl"), call("Write", "/r/sub.ts"));
    writeFileSync(join(s.dir, s.sid, "subagents", "notes.txt"), call("Write", "/r/not-a-transcript.ts"));
    const r = sessionEdits(s.sid, s.cwd, s.projects);
    expect(r.edits.map((e) => e.abs)).toEqual(["/r/sub.ts"]);
    expect(r.files).toBe(2);
  });

  test("found in another projects folder when its cwd's folder has none", () => {
    const s = setup("/Users/x/elsewhere");
    writeFileSync(s.main, call("Edit", "/r/a.ts"));
    expect(sessionEdits(s.sid, "/Users/x/moved", s.projects).edits.map((e) => e.abs)).toEqual(["/r/a.ts"]);
    expect(sessionEdits(s.sid, "", s.projects).edits.map((e) => e.abs)).toEqual(["/r/a.ts"]);
  });

  test("no transcript yet: no edits, and that is not an unknown; a projects folder that cannot be listed is", () => {
    const s = setup();
    expect(sessionEdits(s.sid, s.cwd, s.projects)).toEqual({ edits: [], files: 0 });
    expect(sessionEdits(s.sid, s.cwd, join(s.projects, "missing")).unreadable).toContain("could not be looked for");
    expect(sessionEdits("../x", s.cwd, s.projects).unreadable).toContain("does not name a transcript");
  });
});

describe("read on from where the last read stopped", () => {
  test("appended edits are seen; a line still being written is read once it ends, and is not a bad line", () => {
    const s = setup();
    writeFileSync(s.main, call("Edit", "/r/a.ts"));
    expect(sessionEdits(s.sid, s.cwd, s.projects).edits.length).toBe(1);
    const next = call("Write", "/r/b.ts");
    appendFileSync(s.main, next.slice(0, 40));
    const half = sessionEdits(s.sid, s.cwd, s.projects);
    expect(half.edits.map((e) => e.abs)).toEqual(["/r/a.ts"]);
    expect(half.unreadable).toBeUndefined();
    appendFileSync(s.main, next.slice(40));
    expect(sessionEdits(s.sid, s.cwd, s.projects).edits.map((e) => e.abs)).toEqual(["/r/a.ts", "/r/b.ts"]);
  });

  test("a whole line that is not JSON makes the edits not known", () => {
    const s = setup();
    writeFileSync(s.main, call("Edit", "/r/a.ts") + '{"type":"assistant","content":"tool_use", broken\n');
    const r = sessionEdits(s.sid, s.cwd, s.projects);
    expect(r.edits.length).toBe(1);
    expect(r.unreadable).toContain("1 line(s) of");
  });

  test("a transcript replaced by a shorter one is read again from the start", () => {
    const s = setup();
    writeFileSync(s.main, other(500) + call("Edit", "/r/old.ts"));
    expect(sessionEdits(s.sid, s.cwd, s.projects).edits.map((e) => e.abs)).toEqual(["/r/old.ts"]);
    writeFileSync(s.main, call("Edit", "/r/new.ts"));
    expect(sessionEdits(s.sid, s.cwd, s.projects).edits.map((e) => e.abs)).toEqual(["/r/new.ts"]);
  });

  test("a multi-byte character across the 1 MiB read boundary leaves the offset exact", () => {
    const s = setup();
    // An edit whose path is a run of "é" (2 bytes each), with one "é" split by the 1 MiB read.
    const MiB = 1 << 20;
    const pathFor = (lead: string) => "/r/" + lead + "é".repeat(MiB / 2 + 8) + ".ts";
    const at = (rec: string) => rec.indexOf("/r/") + 3; // the byte where the path's run starts (ASCII before it)
    const lead = (MiB - at(call("Edit", pathFor("")))) % 2 === 1 ? "" : "a";
    const path = pathFor(lead);
    const rec = call("Edit", path);
    const bytes = Buffer.from(rec);
    expect(bytes[MiB - 1]).toBe(0xc3); // the first byte of an "é" ends the first read
    expect(bytes[MiB]).toBe(0xa9); // its second byte begins the next
    writeFileSync(s.main, rec);
    expect(sessionEdits(s.sid, s.cwd, s.projects).edits.map((e) => e.abs)).toEqual([path]);
    appendFileSync(s.main, call("Write", "/r/later.ts"));
    const r = sessionEdits(s.sid, s.cwd, s.projects);
    expect(r.edits.map((e) => e.abs)).toEqual([path, "/r/later.ts"]);
    expect(r.unreadable).toBeUndefined();
  });
});

test("editCalls reads an Agent SDK message and a transcript record alike", () => {
  const rec = JSON.parse(call("Edit", "/r/a.ts"));
  expect(editCalls(rec, "t")).toEqual([{ abs: "/r/a.ts", tool: "Edit", at: "t" }]);
  expect(editCalls({ type: "user", message: rec.message }, "t")).toEqual([]);
  expect(editCalls(null, "t")).toEqual([]);
});
