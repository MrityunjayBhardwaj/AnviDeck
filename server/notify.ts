/**
 * Desktop notifications (#314), the server side: the setting in AnviDeck's own `settings.json`,
 * and the notifier that watches the agent host's events and hands each moment that needs you to
 * the desktop app (one `ANVIDECK-NOTIFY` line on the app's private channel). The app decides
 * whether to show it: only while its window is not in front.
 *
 * Only agents this server runs are notified: another server's agents are its own to tell about.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_NOTIFY, noticesFor, readNotifyFields, type Notice, type NoticeAgent, type NotifyRead, type NotifySettings } from "../shared/notifications";
import { SETTINGS_FILE } from "./agents/github-access";
import type { AgentView, HostEvent } from "./agents/host";

/** The setting, from `settings.json` in AnviDeck's own folder. No file is the default; a broken one is said, never guessed. */
export function readNotify(dir: string): NotifyRead {
  const file = join(dir, SETTINGS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok", settings: { ...DEFAULT_NOTIFY }, source: "default", file };
    return { status: "unreadable", file, reason: (e as Error).message };
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { status: "unreadable", file, reason: `it does not parse: ${(e as Error).message}` };
  }
  if (!j || typeof j !== "object") return { status: "unreadable", file, reason: "it is not an object" };
  const r = readNotifyFields(j as Record<string, unknown>);
  if ("error" in r) return { status: "unreadable", file, reason: r.error };
  return { status: "ok", settings: r.settings, source: r.set ? "set" : "default", file, ...(r.setAt ? { setAt: r.setAt } : {}) };
}

/** Set it, keeping every other setting in the file. Written whole to a temporary file and renamed. */
export function writeNotify(dir: string, settings: NotifySettings, now = new Date()): void {
  const file = join(dir, SETTINGS_FILE);
  let current: Record<string, unknown> = {};
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && typeof j === "object") current = j;
  } catch (e) {
    // A missing file starts empty; a broken one is not written over, so nothing in it is lost.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} could not be read (${(e as Error).message}); fix or move it first`);
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, notifications: settings, notificationsSetAt: now.toISOString() }, null, 2) + "\n");
  renameSync(tmp, file);
}

const slice = (v: AgentView): NoticeAgent => ({
  id: v.id,
  prompt: v.prompt,
  issue: v.issue,
  status: v.status,
  reason: v.reason,
  pendingPermissions: v.pendingPermissions.map((p) => ({ requestId: p.requestId, toolName: p.toolName, ...(p.subagent ? { subagent: p.subagent } : {}) })),
});

/**
 * Watches the host's events. Each agent's last view is kept so a new one is compared with it; a
 * notice of a kind you turned off is dropped here. A settings file that cannot be read does not
 * silence anything: the notice goes out as by default, and the reason is logged once per reason.
 */
export class Notifier {
  private readonly last = new Map<string, NoticeAgent>();
  private loggedUnread: string | null = null;

  constructor(
    private readonly o: {
      /** Is this agent run by this server? */
      mine: (v: AgentView) => boolean;
      settings: () => NotifyRead;
      send: (n: Notice) => void;
      log?: (line: string) => void;
    },
  ) {}

  see(e: HostEvent): void {
    if (e.type !== "agent") return;
    const v = e.data;
    if (!this.o.mine(v)) {
      this.last.delete(v.id);
      return;
    }
    const next = slice(v);
    const prev = this.last.get(v.id);
    this.last.set(v.id, next);
    const notices = noticesFor(prev, next);
    if (!notices.length) return;
    const s = this.o.settings();
    let on: NotifySettings = DEFAULT_NOTIFY;
    if (s.status === "ok") {
      on = s.settings;
      this.loggedUnread = null;
    } else if (this.loggedUnread !== s.reason) {
      this.loggedUnread = s.reason;
      this.o.log?.(`[notify] the notification setting could not be read (${s.file}: ${s.reason}); notifying as by default`);
    }
    for (const n of notices) if (on[n.kind]) this.o.send(n);
  }
}
