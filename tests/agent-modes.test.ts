import { describe, expect, test } from "bun:test";
import { checkMode, FULL_ACCESS_CONFIRM, MODES, modeCapFrom, modeLine, modesOffered, startModeBody } from "../shared/agent-modes";

// #249: what a start dialog may send, and what an agent's card says about its mode.

describe("the modes and the cap", () => {
  test("narrowest first, Ask me in the middle, Full access last; auto is not offered", () => {
    expect(MODES.map((m) => m.mode)).toEqual(["plan", "dontAsk", "default", "acceptEdits", "bypassPermissions"]);
    expect(MODES.some((m) => (m.mode as string) === "auto")).toBe(false);
  });

  test("the default cap allows every mode but Full access, and says where it came from", () => {
    const o = modesOffered(modeCapFrom(undefined));
    expect(o.filter((m) => !m.allowed).map((m) => m.mode)).toEqual(["bypassPermissions"]);
    expect(o[4].why).toBe("above the cap on this machine (Accept edits, from the default (set ANVIDECK_AGENT_MODE_CAP to change it))");
  });

  test("a cap of Plan only allows Plan only", () => {
    expect(modesOffered(modeCapFrom("plan")).filter((m) => m.allowed).map((m) => m.mode)).toEqual(["plan"]);
    expect(checkMode("dontAsk", modeCapFrom("plan"))).toMatchObject({ ok: false, status: 403 });
  });
});

describe("what a start dialog sends", () => {
  const full = modesOffered(modeCapFrom("bypassPermissions"));
  const capped = modesOffered(modeCapFrom(undefined));

  test("a mode the cap allows is sent as itself, with no confirmation", () => {
    expect(startModeBody("acceptEdits", false, capped)).toEqual({ ok: true, body: { mode: "acceptEdits" } });
    expect(startModeBody("plan", true, capped)).toEqual({ ok: true, body: { mode: "plan" } });
  });

  test("Full access is sent only with the box ticked, and then with the exact confirmation the server checks", () => {
    expect(startModeBody("bypassPermissions", false, full)).toMatchObject({ ok: false, why: expect.stringContaining("tick the box") });
    const sent = startModeBody("bypassPermissions", true, full);
    expect(sent).toEqual({ ok: true, body: { mode: "bypassPermissions", confirm: FULL_ACCESS_CONFIRM } });
    if (sent.ok) expect(checkMode(sent.body.mode, modeCapFrom("bypassPermissions"), sent.body.confirm)).toEqual({ ok: true, mode: "bypassPermissions" });
  });

  test("a mode above the cap is never sent, ticked or not; the dialog says why", () => {
    expect(startModeBody("bypassPermissions", true, capped)).toMatchObject({ ok: false, why: expect.stringContaining("above the cap") });
  });

  test("a value that is not a mode is never sent", () => {
    expect(startModeBody("auto", true, full).ok).toBe(false);
  });
});

describe("what the card says", () => {
  test("not reported yet, reported as chosen, and started before modes existed differ", () => {
    expect(modeLine("acceptEdits", undefined)).toEqual({ text: "Accept edits (Claude Code has not reported its mode yet)", wide: false });
    expect(modeLine("acceptEdits", "acceptEdits")).toEqual({ text: "Accept edits", wide: false });
    expect(modeLine(undefined, "default")).toEqual({ text: "Ask me (started before modes were chosen)", wide: false });
  });

  test("Full access is marked wide while it runs as Full access", () => {
    expect(modeLine("bypassPermissions", "bypassPermissions")).toEqual({ text: "Full access", wide: true });
    expect(modeLine("bypassPermissions", undefined).wide).toBe(true);
  });

  test("a narrower mode than chosen says both, and is not marked wide", () => {
    expect(modeLine("bypassPermissions", "default")).toEqual({
      text: "Full access chosen; runs in Ask me, as Claude Code reports (your settings can turn a wider mode off)",
      wide: false,
    });
  });
});
