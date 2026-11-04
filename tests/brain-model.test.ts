// Brain names an entry by catalogue and ID (issue #73): one project can use the
// same ID in two catalogues, and each must show its own title and its own links.
// Pure functions on small fixtures shaped like the real API answers.
import { describe, expect, test } from "bun:test";
import {
  cataloguesHolding,
  entryKey,
  findEntries,
  findTraces,
  refFromId,
  refMatches,
  sameRef,
  sharedIds,
} from "../ui/components/brain-model";
import type { Catalogue, CatalogueEntry, EntryTrace, GitHubArtifact } from "../shared/types";

function entry(id: string, title: string): CatalogueEntry {
  return { id, title, sections: {}, tags: [], grounded: false };
}
function cat(name: string, entries: CatalogueEntry[]): Catalogue {
  return { name, path: `/x/.anvi/${name}.md`, entries, lastModified: new Date(0) };
}
function art(id: string): GitHubArtifact {
  return { type: "issue", id, title: id, url: null, date: "2026-01-01", confidence: "high", matchedKeywords: [] };
}
function trace(catalogue: string, entryId: string, ids: string[]): EntryTrace {
  return { entryId, entryTitle: `${catalogue} ${entryId}`, catalogue, artifacts: ids.map(art) };
}

// X1 is used by hetvabhasa and krama (listed in that order, as the API lists them);
// X2 by hetvabhasa only.
const CATS = [
  cat("hetvabhasa", [entry("X1", "trap one"), entry("X2", "trap two")]),
  cat("vyapti", [entry("X9", "rule nine")]),
  cat("krama", [entry("X1", "step one")]),
];
const TRACES = [
  trace("hetvabhasa", "X1", ["#10", "#11"]),
  trace("hetvabhasa", "X2", ["#20"]),
  trace("krama", "X1", ["#30"]),
];

describe("an entry selected in its catalogue", () => {
  test("the second catalogue's entry shows its own title, not the first's", () => {
    const got = findEntries(CATS, { catalogue: "krama", id: "X1" });
    expect(got.map((m) => [m.catalogue, m.entry.title])).toEqual([["krama", "step one"]]);
    const first = findEntries(CATS, { catalogue: "hetvabhasa", id: "X1" });
    expect(first.map((m) => [m.catalogue, m.entry.title])).toEqual([["hetvabhasa", "trap one"]]);
  });

  test("the second catalogue's entry shows its own linked artifacts", () => {
    const krama = findTraces(TRACES, { catalogue: "krama", id: "X1" }).flatMap((t) => t.artifacts.map((a) => a.id));
    expect(krama).toEqual(["#30"]);
    const het = findTraces(TRACES, { catalogue: "hetvabhasa", id: "X1" }).flatMap((t) => t.artifacts.map((a) => a.id));
    expect(het).toEqual(["#10", "#11"]);
  });

  test("highlighting matches the catalogue as well as the ID", () => {
    const ref = { catalogue: "krama", id: "X1" };
    expect(refMatches(ref, "krama", "X1")).toBe(true);
    expect(refMatches(ref, "hetvabhasa", "X1")).toBe(false);
    expect(refMatches(ref, "krama", "X2")).toBe(false);
  });

  test("selecting the other catalogue's entry is a different selection, not a toggle-off", () => {
    expect(sameRef({ catalogue: "krama", id: "X1" }, { catalogue: "hetvabhasa", id: "X1" })).toBe(false);
    expect(sameRef({ catalogue: "krama", id: "X1" }, { catalogue: "krama", id: "X1" })).toBe(true);
    expect(sameRef({ catalogue: null, id: "X1" }, { catalogue: "krama", id: "X1" })).toBe(false);
  });

  test("entry keys differ by catalogue", () => {
    expect(entryKey("krama", "X1")).not.toBe(entryKey("hetvabhasa", "X1"));
  });
});

describe("an entry named by ID only (the hook log)", () => {
  test("an ID one catalogue holds is pinned to it", () => {
    expect(refFromId(CATS, "X2")).toEqual({ catalogue: "hetvabhasa", id: "X2" });
    expect(refFromId(CATS, "X9")).toEqual({ catalogue: "vyapti", id: "X9" });
  });

  test("an ID two catalogues hold stays unpinned and names both entries", () => {
    const ref = refFromId(CATS, "X1");
    expect(ref).toEqual({ catalogue: null, id: "X1" });
    expect(findEntries(CATS, ref).map((m) => m.catalogue)).toEqual(["hetvabhasa", "krama"]);
    expect(findTraces(TRACES, ref).map((t) => t.catalogue)).toEqual(["hetvabhasa", "krama"]);
    expect(refMatches(ref, "krama", "X1")).toBe(true);
    expect(refMatches(ref, "hetvabhasa", "X1")).toBe(true);
  });

  test("an ID no catalogue holds is unpinned and names nothing", () => {
    const ref = refFromId(CATS, "X404");
    expect(ref.catalogue).toBeNull();
    expect(findEntries(CATS, ref)).toEqual([]);
  });

  test("the catalogues holding an ID, and the IDs held twice", () => {
    expect(cataloguesHolding(CATS, "X1")).toEqual(["hetvabhasa", "krama"]);
    expect(cataloguesHolding(CATS, "X2")).toEqual(["hetvabhasa"]);
    expect([...sharedIds(CATS)]).toEqual(["X1"]);
  });

  test("an ID repeated inside one catalogue is not shared between catalogues", () => {
    const dup = [cat("hetvabhasa", [entry("X5", "a"), entry("X5", "b")]), cat("krama", [entry("X6", "c")])];
    expect([...sharedIds(dup)]).toEqual([]);
    expect(refFromId(dup, "X5")).toEqual({ catalogue: "hetvabhasa", id: "X5" });
  });
});
