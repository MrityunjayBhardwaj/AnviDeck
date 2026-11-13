import { setDefaultTimeout } from "bun:test";

/**
 * The time a test may take when it names no limit of its own (#273).
 *
 * Many tests spawn real `git`, `gh` and `node` processes. On this machine, other Claude Code
 * sessions often hold the load average at 50 to 120, and a test that takes 0.7 s alone then
 * takes 3 to 5 s, so bun's default of 5 s failed tests whose code was fine (#273: child-output,
 * from-issue-upstream, push-pr). 30 s covers that with room; a test that really hangs still
 * fails, only later. Tests that check how long something took assert that themselves, and a
 * test's own limit still wins over this one.
 */
setDefaultTimeout(30_000);
