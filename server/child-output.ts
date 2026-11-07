/**
 * Waiting for a child process's output (#253): the one place that does it.
 *
 * Normally a child's output ends just after it exits. Under Bun that end sometimes never comes:
 * the process has exited and its output has arrived, and yet `close` never fires and the stream
 * never finishes. Seen under `bun test` on 2026-11-07, with no other process holding the pipe; why
 * Bun does it is not known. (A process the child left running can hold the pipe open too, with the
 * same effect.) Anything that waits only for the end then waits forever, and a guard run that
 * never finishes keeps its slot, so two of them would stop Map, Design and Code for good.
 *
 * So once the process has exited, the wait is over as soon as its output has gone quiet for
 * AFTER_EXIT_QUIET_MS. Quiet, not a fixed time: a large output on a busy machine is still arriving.
 * The answer says the end never came (`ended: false`), and each time is counted and logged. The
 * output may then be whole or cut short, so a caller must not take it as a complete answer unless
 * it can tell: JSON that parses can; plain text cannot.
 */
import type { ChildProcess } from "node:child_process";

export const AFTER_EXIT_QUIET_MS = 3000;

let lost = 0;
/** How many waits this server has ended because a child's output never ended. */
export const lostOutputEnds = () => lost;

function noteLost(what: string): void {
  lost++;
  console.warn(`[child] ${what}: the process exited, but its output never ended; stopped waiting (${lost} since start)`);
}

/** What a caller says when it will not trust output that never ended. */
export const outputNeverEnded = (what: string) => `${what} exited, but its output never ended, so it may be cut short and was not used`;

/** Calls `check` until the output has been quiet for `quietMs`, measured from `lastData()`. */
function whenQuiet(lastData: () => number, quietMs: number, then: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const left = lastData() + quietMs - Date.now();
    if (left <= 0) then();
    else timer = setTimeout(check, left);
  };
  timer = setTimeout(check, quietMs);
  return () => clearTimeout(timer);
}

/**
 * For node:child_process: `done` once, on `close`, or else once the child has exited and its
 * output has gone quiet. Put the child's own data handlers on as usual.
 */
export function settleAfterExit(
  child: ChildProcess,
  what: string,
  done: (code: number | null, signal: NodeJS.Signals | null, ended: boolean) => void,
  quietMs = AFTER_EXIT_QUIET_MS,
): void {
  let last = Date.now();
  let settled = false;
  let cancel = () => {};
  for (const s of child.stdio) (s as NodeJS.ReadableStream | null)?.on?.("data", () => (last = Date.now()));
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    cancel();
    done(code, signal, true);
  });
  child.on("exit", (code, signal) => {
    cancel = whenQuiet(() => last, quietMs, () => {
      if (settled) return;
      settled = true;
      noteLost(what);
      done(code, signal, false);
    });
  });
}

function collect(stream: ReadableStream<Uint8Array>, onData: () => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // True only when the stream reached its end. One that failed may have been cut short, so it has not ended.
  const finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return true;
        text += decoder.decode(value, { stream: true });
        onData();
      }
    } catch {
      return false;
    }
  })();
  return { finished, text: () => text, stop: () => void reader.cancel().catch(() => {}) };
}

/** For Bun.spawn with stdout and stderr "pipe": the process's output and exit code, without waiting forever for the end. */
export async function readProcess(
  proc: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> },
  what: string,
  quietMs = AFTER_EXIT_QUIET_MS,
): Promise<{ stdout: string; stderr: string; code: number; ended: boolean }> {
  let last = Date.now();
  const onData = () => (last = Date.now());
  const out = collect(proc.stdout, onData);
  const err = collect(proc.stderr, onData);
  const code = await proc.exited;
  const ended = await new Promise<boolean>((resolve) => {
    const cancel = whenQuiet(() => last, quietMs, () => resolve(false));
    void Promise.all([out.finished, err.finished]).then(([outEnded, errEnded]) => {
      cancel();
      resolve(outEnded && errEnded);
    });
  });
  if (!ended) {
    noteLost(what);
    out.stop();
    err.stop();
  }
  return { stdout: out.text(), stderr: err.text(), code, ended };
}
