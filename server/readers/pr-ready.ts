import { runAsync } from "./replay";
import { judgeReady, parsePrKey, type PrReadyView, type ReadyAnswer } from "../../shared/pr-ready";

/**
 * Which of Home's PRs are ready to merge (#81). Read only: one `gh pr view` per PR, judged by
 * shared/pr-ready.ts. An answer is kept for READY_TTL_MS; a failure is never kept, and comes
 * back as `could-not-read` with GitHub's words, never as "not ready".
 */

export const READY_FIELDS = "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefOid,body";
export const READY_TTL_MS = 180_000;
/** At most this many PRs are asked about per request; the rest are refused by the route. */
export const READY_MAX = 40;
const CONCURRENCY = 4;

type Runner = (cmd: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string; err: string }>;

const cache = new Map<string, { at: number; answer: ReadyAnswer }>();
const inFlight = new Map<string, Promise<ReadyAnswer>>();

export function resetReadyCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Turn one `gh pr view` answer into a verdict. A bad answer is could-not-read, never "not ready". */
export function readyFromGh(key: string, r: { ok: boolean; out: string; err: string }, now = Date.now()): ReadyAnswer {
  const k = parsePrKey(key);
  if (!k) return { status: "could-not-read", key, reason: "not a PR key (owner/name#N)" };
  if (!r.ok) return { status: "could-not-read", key, reason: (r.err || "gh pr view failed").slice(0, 200) };
  let v: PrReadyView;
  try {
    const j = JSON.parse(r.out) as Record<string, unknown>;
    if (typeof j.state !== "string" || typeof j.mergeable !== "string" || typeof j.headRefOid !== "string")
      return { status: "could-not-read", key, reason: "gh pr view answered without state, mergeable or headRefOid" };
    v = {
      number: Number(j.number ?? k.number),
      state: j.state,
      isDraft: !!j.isDraft,
      mergeable: j.mergeable,
      reviewDecision: typeof j.reviewDecision === "string" ? j.reviewDecision : null,
      statusCheckRollup: Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : null,
      headRefOid: j.headRefOid,
      body: typeof j.body === "string" ? j.body : null,
    };
  } catch {
    return { status: "could-not-read", key, reason: "gh pr view returned non-JSON output" };
  }
  return { status: "ok", key, number: k.number, repo: k.repo, checkedAt: new Date(now).toISOString(), ...judgeReady(v) };
}

async function askOne(key: string, run: Runner): Promise<ReadyAnswer> {
  const k = parsePrKey(key)!;
  const r = await run(["gh", "pr", "view", String(k.number), "--repo", k.repo, "--json", READY_FIELDS], 20_000);
  const answer = readyFromGh(key, r);
  if (answer.status === "ok") cache.set(key, { at: Date.now(), answer });
  return answer;
}

/** The verdict for each key, in the order given. Keys that are not PR keys are could-not-read. */
export async function readReady(keys: string[], run: Runner = runAsync, now = Date.now()): Promise<ReadyAnswer[]> {
  const out: (ReadyAnswer | null)[] = keys.map(() => null);
  const todo: number[] = [];
  keys.forEach((key, i) => {
    if (!parsePrKey(key)) out[i] = { status: "could-not-read", key, reason: "not a PR key (owner/name#N)" };
    else {
      const hit = cache.get(key);
      if (hit && now - hit.at < READY_TTL_MS) out[i] = hit.answer;
      else todo.push(i);
    }
  });
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++]!;
      const key = keys[i]!;
      let p = inFlight.get(key);
      if (!p) {
        p = askOne(key, run).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      out[i] = await p;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return out as ReadyAnswer[];
}
