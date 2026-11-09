import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { readGithubAccess, withGithubAccess, writeGithubAccess } from "../server/agents/github-access";
import { agentRoutes } from "../server/routes/agents";
import { githubAccessLine } from "../shared/github-access";
import type { ClaudeBinary } from "../server/agents/login";

// #147: Agent GitHub access. "none" must keep an agent's gh and git away from your login; these
// check it against stand-ins (a fake gh login, a fake git credential helper, ssh's own settings
// printout), each reached under "your login" and not under "none", so no test touches GitHub.

const dirs: string[] = [];
const scratch = (p = "gh-access-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = (env: Record<string, string>, cmd: string, args: string[], input?: string) => {
  const r = spawnSync(cmd, args, { env, input, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

/** A server environment that reaches stand-in GitHub credentials: a gh login, a git credential helper, an ssh agent. */
function standIns() {
  const d = scratch();
  const gh = join(d, "gh");
  mkdirSync(gh);
  writeFileSync(join(gh, "hosts.yml"), "github.com:\n  oauth_token: gho_STANDIN\n  user: someone\n  git_protocol: https\n");
  const gitconfig = join(d, "gitconfig");
  writeFileSync(gitconfig, `[credential "https://github.com"]\n\thelper = "!f() { echo username=someone; echo password=STANDIN; }; f"\n[user]\n\tname = Someone\n\temail = someone@example.invalid\n`);
  // As macOS's own gitconfig does (credential.helper osxkeychain): a helper in the system file.
  const system = join(d, "system-gitconfig");
  writeFileSync(system, `[credential]\n\thelper = "!f() { echo username=someone; echo password=SYSTEM; }; f"\n`);
  const base: Record<string, string> = {
    GIT_CONFIG_SYSTEM: system,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: d,
    GH_CONFIG_DIR: gh,
    GIT_CONFIG_GLOBAL: gitconfig,
    SSH_AUTH_SOCK: join(d, "agent.sock"),
    GITHUB_TOKEN: "ghp_STANDIN",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo password=FROMENV; }; f",
  };
  return { base, none: withGithubAccess(base, "none", join(d, "empty-gh")), dir: d };
}

describe("the environment under each setting", () => {
  test("your login changes nothing", () => {
    const { base } = standIns();
    expect(withGithubAccess(base, "your-login", "/unused")).toEqual({ env: base, removed: [] });
  });

  test("none removes the token variables and the ssh agent, and says which by name", () => {
    const { none } = standIns();
    expect(none.removed).toEqual(["GH_CONFIG_DIR", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]);
    expect(none.env.GITHUB_TOKEN).toBeUndefined();
    expect(none.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(existsSync(none.env.GH_CONFIG_DIR!)).toBe(true);
    expect(none.env.GIT_CONFIG_COUNT).toBe("3");
  });

  (has("gh") ? test : test.skip)("gh: the stand-in login is found under your login, not under none", () => {
    const { base, none } = standIns();
    const mine = run({ ...base, GITHUB_TOKEN: "" }, "gh", ["auth", "token"]);
    expect(mine).toMatchObject({ code: 0 });
    expect(mine.out).toContain("gho_STANDIN");
    const theirs = run(none.env, "gh", ["auth", "token"]);
    expect(theirs.code).not.toBe(0);
    expect(theirs.out).not.toContain("STANDIN");
  });

  test("git over HTTPS: a credential helper answers under your login, none under none", () => {
    const { base, none } = standIns();
    const ask = "protocol=https\nhost=github.com\n\n";
    expect(run({ ...base, GIT_TERMINAL_PROMPT: "0" }, "git", ["credential", "fill"], ask).out).toContain("password=");
    const r = run(none.env, "git", ["credential", "fill"], ask);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("password=");
  });

  test("git over HTTPS: the system gitconfig's helper is not read under none", () => {
    const { base, none } = standIns();
    const ask = "protocol=https\nhost=github.com\n\n";
    // Only the system file's helper left: it answers under your login, and is not read under none.
    const onlySystem = { ...base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" };
    expect(run(onlySystem, "git", ["credential", "fill"], ask).out).toContain("password=SYSTEM");
    expect(run({ ...none.env, GIT_CONFIG_GLOBAL: "/dev/null" }, "git", ["credential", "fill"], ask).out).not.toContain("password=");
  });

  test("git over SSH: ssh would use no agent and no key file under none", () => {
    const { none } = standIns();
    const printed = run(none.env, "sh", ["-c", `${none.env.GIT_SSH_COMMAND} -G github.com`]).out.toLowerCase();
    expect(printed).toContain("identityagent none");
    expect(printed).toContain("identityfile /dev/null");
    expect(printed).toContain("identitiesonly yes");
    expect(printed).not.toMatch(/identityfile .*id_(ed25519|rsa|ecdsa)/);
  });

  test("commits still carry your name and email under none: the agent can commit locally", () => {
    const { none } = standIns();
    expect(run(none.env, "git", ["var", "GIT_AUTHOR_IDENT"]).out).toContain("Someone <someone@example.invalid>");
  });
});

describe("the setting's file", () => {
  test("no file is your login, by default; a set value is read back with when", () => {
    const d = scratch();
    expect(readGithubAccess(d)).toMatchObject({ status: "ok", access: "your-login", source: "default" });
    writeGithubAccess(d, "none", new Date("2026-11-10T10:00:00Z"));
    expect(readGithubAccess(d)).toMatchObject({ status: "ok", access: "none", source: "set", setAt: "2026-11-10T10:00:00.000Z" });
  });

  test("other settings in the file are kept", () => {
    const d = scratch();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ somethingElse: 7 }));
    writeGithubAccess(d, "none");
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8"))).toMatchObject({ somethingElse: 7, agentGithubAccess: "none" });
  });

  test("a broken file is said, never read as your login, and never written over", () => {
    const d = scratch();
    writeFileSync(join(d, "settings.json"), "{ not json");
    expect(readGithubAccess(d)).toMatchObject({ status: "unreadable", reason: expect.stringContaining("does not parse") });
    expect(() => writeGithubAccess(d, "none")).toThrow("fix or move it first");
    expect(readFileSync(join(d, "settings.json"), "utf8")).toBe("{ not json");
    writeFileSync(join(d, "settings.json"), JSON.stringify({ agentGithubAccess: "everything" }));
    expect(readGithubAccess(d)).toMatchObject({ status: "unreadable", reason: expect.stringContaining('"everything"') });
  });
});

describe("the host applies it at each start and resume", () => {
  const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
  const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
  const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s1", uuid: "r" } as unknown as SDKMessage;
  function host() {
    const dir = scratch("gh-access-reg-");
    const calls: Options[] = [];
    const query: QueryFn = ({ options }) => {
      calls.push(options);
      return (async function* () {
        yield init;
        yield result;
      })();
    };
    const h = new AgentHost({
      registry: new AgentRegistry(dir),
      query,
      resolveClaude: () => CLAUDE,
      env: () => ({ env: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "x" }, stripped: [] }),
      cap: 5,
      ghConfigDir: (id) => join(dir, "..", `${dir.split("/").pop()}-gh`, id),
    });
    return { h, calls, dir };
  }
  const until = async (p: () => boolean) => {
    for (let i = 0; i < 400 && !p(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!p()) throw new Error("timed out");
  };

  test("your login by default: the environment is as before, and the agent says so", async () => {
    const { h, calls } = host();
    const a = h.start({ cwd: scratch(), prompt: "x" });
    await until(() => h.get(a.id).status === "done");
    expect(calls[0]!.env).toMatchObject({ SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "x" });
    expect(h.get(a.id)).toMatchObject({ githubAccess: "your-login", githubRemoved: [] });
  });

  test("none: the agent's environment has no route to your login, and its record names what was taken out", async () => {
    const { h, calls, dir } = host();
    writeGithubAccess(dir, "none");
    const a = h.start({ cwd: scratch(), prompt: "x" });
    await until(() => h.get(a.id).status === "done");
    expect(calls[0]!.env!.SSH_AUTH_SOCK).toBeUndefined();
    expect(calls[0]!.env!.GH_TOKEN).toBeUndefined();
    expect(calls[0]!.env!.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(h.get(a.id)).toMatchObject({ githubAccess: "none", githubRemoved: ["GH_TOKEN", "SSH_AUTH_SOCK"] });
    // Each agent gets a gh folder of its own: a login one puts there reaches no other.
    const b = h.start({ cwd: scratch(), prompt: "y" });
    await until(() => h.get(b.id).status === "done");
    expect(calls[0]!.env!.GH_CONFIG_DIR).toEndWith(`/${a.id}`);
    expect(calls[1]!.env!.GH_CONFIG_DIR).toEndWith(`/${b.id}`);
  });

  test("a resume gets the setting as it is now", async () => {
    const { h, calls, dir } = host();
    const a = h.start({ cwd: scratch(), prompt: "x" });
    await until(() => h.get(a.id).status === "done" && h.running === 0);
    writeGithubAccess(dir, "none");
    h.resume(a.id, "go on");
    await until(() => calls.length === 2 && h.get(a.id).status === "done");
    expect(calls[1]!.env!.SSH_AUTH_SOCK).toBeUndefined();
    expect(h.get(a.id).githubAccess).toBe("none");
  });

  test("a setting that cannot be read refuses the start (503), and nothing starts; bot in the file refuses (409)", () => {
    const { h, calls, dir } = host();
    const refused = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        if (e instanceof HostError) return e;
        throw e;
      }
      throw new Error("expected a refusal");
    };
    writeFileSync(join(dir, "settings.json"), "{ broken");
    expect(refused(() => h.start({ cwd: scratch(), prompt: "x" })).status).toBe(503);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ agentGithubAccess: "bot" }));
    expect(refused(() => h.start({ cwd: scratch(), prompt: "x" })).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(h.list()).toHaveLength(0);
  });

  test("the route: the overview says the setting and why bot is not offered; the write sets it, refuses bot and nonsense", async () => {
    const { h, dir } = host();
    const app = new Hono();
    app.route("/api/agents", agentRoutes(h, async () => ({ ok: true }) as never));
    const get = async () =>
      (await (await app.request("http://localhost:4475/api/agents", { headers: { host: "localhost:4475" } })).json()) as {
        githubAccess: { setting: { access: string; source: string }; options: { access: string; unavailable: string | null }[] };
      };
    const post = (b: unknown) =>
      app.request("http://localhost:4475/api/agents/settings/github-access", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:4475", origin: "http://localhost:4475" },
        body: JSON.stringify(b),
      });
    const before = await get();
    expect(before.githubAccess.setting).toMatchObject({ access: "your-login", source: "default" });
    expect(before.githubAccess.options.map((o) => `${o.access}:${o.unavailable === null}`)).toEqual(["your-login:true", "none:true", "bot:false"]);
    expect((await post({ access: "bot" })).status).toBe(409);
    expect((await post({ access: "everything" })).status).toBe(400);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    const set = await post({ access: "none" });
    expect(set.status).toBe(200);
    expect((await get()).githubAccess.setting).toMatchObject({ access: "none", source: "set" });
  });
});

describe("what the card says", () => {
  test("each access, and agents from before the setting", () => {
    expect(githubAccessLine("your-login")).toEqual({ text: "Your login: can push and merge as you", yours: true });
    expect(githubAccessLine("none")).toEqual({ text: "None: commits locally; gh and git have no login", yours: false });
    expect(githubAccessLine(undefined)).toEqual({ text: "Your login (started before this setting existed)", yours: true });
  });
});
