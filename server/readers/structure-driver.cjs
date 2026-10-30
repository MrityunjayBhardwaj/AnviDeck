#!/usr/bin/env node
// structure-driver.cjs — run anvi's structure guard IN NODE and print its judgement as JSON.
//
// Why a child process and not an in-process require from Bun: the anvi merge hook runs the guard
// under node (structure-merge-hook.js `guardAt`, `run(process.execPath, [script, ...])`), and the
// guard resolves the package's own TypeScript with `require.resolve('typescript', { paths: [pkgDir] })`
// (structure-graph.js `tsExtractor`). Running the same exported functions under the same runtime
// keeps this dashboard's numbers the guard's numbers, and keeps the package's TypeScript out of the
// dashboard's memory.
//
// It calls the guard's exported functions — it does not parse the guard's text output — in the
// same order the guard's `main` does for a `--package --design --baseline --ref` run:
//   read design + baseline → designProblem → designCheck → checkoutAtRef (git archive of the ref,
//   never the working tree) → loadExtractor + buildGraph → cleanup → notMeasured → judge → ratchet.
//
// Usage: node structure-driver.cjs <structure-guard.js path> <json input>
//   input: { dir, design, baseline, designId?, extractor?, ref }
// Prints one JSON object on stdout: { status: "measured", ... } or { status: "not-measured", reason }.
// Writes nothing except the guard's own temporary archive under os.tmpdir() (TMPDIR), which the
// guard removes itself (structure-guard.js checkoutAtRef → cleanup).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function notMeasured(reason, extra) { out({ status: 'not-measured', reason, ...(extra || {}) }); process.exit(0); }

process.on('uncaughtException', e => {
  notMeasured(`the guard crashed, so it gave no verdict: ${e && e.message ? String(e.message).split('\n')[0] : String(e)}`);
});

const guardPath = process.argv[2];
let input;
try { input = JSON.parse(process.argv[3] || ''); } catch { notMeasured('the driver was given no readable input'); }

let G;
try { G = require(guardPath); } catch (e) { notMeasured(`cannot load the structure guard ${guardPath}: ${e.message}`); }

// The guard finds its shared modules from the repo layout or the installed hooks directory
// (structure-guard.js loadFromCandidates). structure-graph.js is not re-exported, so it is found
// the same way, from the same two places, in the same order.
function loadFromCandidates(name) {
  const candidates = [
    path.join(path.dirname(guardPath), '..', 'hooks', name),
    path.join(os.homedir(), '.claude', 'hooks', name),
  ];
  for (const c of candidates) { try { return { mod: require(c), from: c }; } catch { /* next */ } }
  throw new Error(`cannot locate ${name} in ${candidates.join(' | ')}`);
}

function readJson(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.message}`); }
}

let design, baseline = null;
try {
  design = readJson(input.design, 'design');
  if (input.baseline) baseline = readJson(input.baseline, 'baseline');
} catch (e) { notMeasured(e.message); }

const problem = G.designProblem(design);
if (problem) notMeasured(problem);
if (baseline && !baseline.rules) notMeasured(`the baseline ${input.baseline} has no "rules" section — refusing to treat it as empty`);

const id = G.designId(design);
// The registry entry names the design it was armed under; a design edited since is not judged
// (structure-merge-hook.js judgeMerge, the `entry.designId !== id` check).
if (input.designId && input.designId !== id)
  notMeasured(`the design on disk is ${id}, but the package was armed under ${input.designId}`, { designId: id });
const frame = G.designCheck(design, baseline, null);
if (frame.mismatch) notMeasured(`${frame.mismatch}. No verdict is given across two designs.`, { designId: id });

let S, graphModuleFrom;
try { const got = loadFromCandidates('structure-graph.js'); S = got.mod; graphModuleFrom = got.from; }
catch (e) { notMeasured(e.message); }

let pkgDir;
try { pkgDir = fs.realpathSync(input.dir); } catch { notMeasured(`no such package ${input.dir}`); }

const at = G.checkoutAtRef(pkgDir, input.ref);
if (!at) notMeasured(`${pkgDir} is not inside a git checkout, so there is no commit to measure (the working tree is never measured)`);
if (at.notMeasured) notMeasured(at.notMeasured);

const t0 = Date.now();
let got;
try {
  const extractor = S.loadExtractor(input.extractor ? { extractor: input.extractor } : {}, at.dir);
  got = S.buildGraph({ pkgDir: at.dir, design, extractor, cachePath: null, proposed: null });
} finally { at.cleanup(); }
const buildMs = Date.now() - t0;
const measuredAt = { ref: at.ref, sha: at.sha, date: at.date, why: at.why, modulesFrom: at.modulesFrom };
if (got.notMeasured) notMeasured(got.notMeasured, { measuredAt });

const graph = got.graph;
const why = G.notMeasured(graph);
if (why) notMeasured(why, { measuredAt });

const results = G.judge(graph, design);
const ledger = G.ratchet(results, baseline);
const of = G.componentOf(design, graph.root);
const allowed = new Set((design.allowed || []).map(([a, b]) => G.edgeKey(a, b)));
const held = {
  divergence: new Set((baseline && baseline.rules && baseline.rules.divergence) || []),
  cycle: new Set((baseline && baseline.rules && baseline.rules.cycle) || []),
};
const divergent = new Set(results.divergence.found.map(f => f.key));

// One row per edge of the graph the guard judged. `class` follows the guard's own reading:
// an edge touching a module outside every component is not examined by the divergence rule
// (structure-rules.js divergences); inside one component every import is allowed; between two
// it is declared (allowed) or a divergence, which the baseline holds (grandfathered) or not (new).
const edges = graph.edges.map(([a, b]) => {
  const key = G.edgeKey(a, b);
  const ca = of(a), cb = of(b);
  let cls;
  if (ca === undefined || cb === undefined) cls = 'unmapped';
  else if (ca === cb) cls = 'internal';
  else if (allowed.has(G.edgeKey(ca, cb))) cls = 'allowed';
  else if (divergent.has(key)) cls = held.divergence.has(key) ? 'grandfathered' : 'new';
  else cls = 'allowed';
  const cycle = graph.circular.has(key) ? (held.cycle.has(key) ? 'grandfathered' : 'new') : null;
  return { from: a, to: b, fromComponent: ca ?? null, toComponent: cb ?? null,
    pair: ca !== undefined && cb !== undefined && ca !== cb ? G.edgeKey(ca, cb) : null,
    class: cls, cycle, reexport: graph.reexports.has(key), typeOnly: graph.typeOnly.has(key) };
});

const strip = s => String(s).slice(graph.root.length);
out({
  status: 'measured',
  designId: id,
  baselineDesignId: frame.measuredUnder,
  baselineUnstamped: frame.unstamped,
  measuredAt,
  root: graph.root,
  extractor: got.stats.extractor,
  graphModule: graphModuleFrom,
  typeOnlyImports: graph.typeOnlyImports,
  buildMs,
  modules: [...graph.modules].sort().map(m => ({ path: m, rel: strip(m), component: of(m) ?? null })),
  edges,
  cycles: [...graph.circular].sort(),
  rules: Object.fromEntries(G.RULES.map(rule => [rule, {
    examined: results[rule].examined,
    total: ledger[rule].total,
    grandfathered: ledger[rule].grandfathered,
    new: ledger[rule].fresh.map(f => ({ key: f.key, detail: f.detail, pair: f.pair || null })),
    fixed: ledger[rule].fixed,
  }])),
  byPair: G.byPair(results.divergence.found),
  unmapped: results.divergence.unmapped,
  absences: results.divergence.absences,
  relative: graph.relative,
  unresolved: graph.unresolved,
  baselineKeys: { divergence: held.divergence.size, cycle: held.cycle.size },
  retiredSections: G.retiredSections(baseline),
});
