#!/usr/bin/env node
// refusals-driver.cjs — the guard's verbatim reason for each refused edit, read by anvi's own
// instrument (structure-refusals.js `readTranscript`), IN NODE.
//
// Why this exists: the instrument's --json report drops each call's `reason` (the guard's words)
// and keeps the transcript path and tool_use id. This reads those transcripts again with the
// instrument's exported `readTranscript` and `needles` — the same function that classified the
// call in the first place — so the words shown beside a refusal are the words it was judged on,
// not a second reading of the transcript written here.
//
// Usage: node refusals-driver.cjs <structure-refusals.js path> <json input>
//   input: { pkgDir, since, until, wanted: [{ transcript, id }] }
// Prints one JSON object on stdout: { ok: true, reasons: { [id]: { outcome, reason } }, errors: { [id]: why } }
// or { ok: false, reason }. Reads only; writes nothing.

'use strict';

function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function fail(reason) { out({ ok: false, reason }); process.exit(0); }

process.on('uncaughtException', e => fail(`the instrument crashed while re-reading reasons: ${e && e.message ? String(e.message).split('\n')[0] : String(e)}`));

const scriptPath = process.argv[2];
let input;
try { input = JSON.parse(process.argv[3] || ''); } catch { fail('the driver was given no readable input'); }

let R;
try { R = require(scriptPath); } catch (e) { fail(`cannot load ${scriptPath}: ${e.message}`); }
if (typeof R.readTranscript !== 'function' || typeof R.needles !== 'function')
  fail(`${scriptPath} does not export readTranscript and needles`);

const { needles } = R.needles(input.pkgDir);
const byFile = new Map();
for (const w of input.wanted || []) {
  if (!byFile.has(w.transcript)) byFile.set(w.transcript, new Set());
  byFile.get(w.transcript).add(w.id);
}
const reasons = {}, errors = {};
for (const [file, ids] of byFile) {
  const r = R.readTranscript(file, input.pkgDir, needles, input.since, input.until || null);
  if (r.unreadable) { for (const id of ids) errors[id] = `the transcript ${file} could not be read`; continue; }
  const found = new Map(r.calls.map(c => [c.id, c]));
  for (const id of ids) {
    const c = found.get(id);
    if (!c) errors[id] = `the call ${id} is no longer in ${file} within the window`;
    else reasons[id] = { outcome: c.outcome, reason: typeof c.reason === 'string' ? c.reason : null };
  }
}
out({ ok: true, reasons, errors });
