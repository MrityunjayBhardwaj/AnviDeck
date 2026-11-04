// Which catalogue entry a Brain selection means (issue #73).
//
// One project can use the same ID in two catalogues (an invariant in vyapti and
// its alignment note in dharana, a trap in hetvabhasa and a step in krama), so an
// entry is named by catalogue AND ID. Matching on the ID alone shows the first
// catalogue's entry, title and linked artifacts for both.
//
// The hook log is the one source that cannot say which: it records bare IDs
// scraped from the boundary text (`patterns`: H/P/SP…, `invariants`: V/SV…), not
// the catalogue that holds them. A reference built from it carries
// `catalogue: null` and matches every entry with that ID; if exactly one
// catalogue holds the ID, `refFromId` pins it.
//
// Pure functions, no DOM: tests/brain-model.test.ts.
import type { Catalogue, CatalogueEntry, EntryTrace } from "../../shared/types";

export interface EntryRef {
  /** null when the source named only the ID and more than one (or no) catalogue holds it. */
  catalogue: string | null;
  id: string;
}

/** The key one entry is known by across Brain: "catalogue/id". */
export function entryKey(catalogue: string, id: string): string {
  return `${catalogue}/${id}`;
}

/** Does `ref` name the entry `id` of `catalogue`? An unpinned ref names every catalogue's. */
export function refMatches(ref: EntryRef, catalogue: string, id: string): boolean {
  return ref.id === id && (ref.catalogue === null || ref.catalogue === catalogue);
}

export function sameRef(a: EntryRef, b: EntryRef): boolean {
  return a.id === b.id && a.catalogue === b.catalogue;
}

/** Every entry `ref` names, in catalogue order: one when pinned, possibly several when not. */
export function findEntries(
  catalogues: Catalogue[],
  ref: EntryRef,
): { catalogue: string; entry: CatalogueEntry }[] {
  const out: { catalogue: string; entry: CatalogueEntry }[] = [];
  for (const cat of catalogues) {
    for (const entry of cat.entries) {
      if (refMatches(ref, cat.name, entry.id)) out.push({ catalogue: cat.name, entry });
    }
  }
  return out;
}

/** The GitHub trace rows of the entries `ref` names. */
export function findTraces(traces: EntryTrace[], ref: EntryRef): EntryTrace[] {
  return traces.filter((t) => refMatches(ref, t.catalogue, t.entryId));
}

/** The catalogues holding `id`, for a source that named only the ID. */
export function cataloguesHolding(catalogues: Catalogue[], id: string): string[] {
  const out: string[] = [];
  for (const cat of catalogues) {
    if (cat.entries.some((e) => e.id === id) && !out.includes(cat.name)) out.push(cat.name);
  }
  return out;
}

/** A ref for an ID named without its catalogue: pinned when exactly one catalogue holds it. */
export function refFromId(catalogues: Catalogue[], id: string): EntryRef {
  const holders = cataloguesHolding(catalogues, id);
  return { catalogue: holders.length === 1 ? holders[0]! : null, id };
}

/** IDs used by more than one catalogue of the project. */
export function sharedIds(catalogues: Catalogue[]): Set<string> {
  const firstCat = new Map<string, string>();
  const shared = new Set<string>();
  for (const cat of catalogues) {
    for (const e of cat.entries) {
      const seen = firstCat.get(e.id);
      if (seen === undefined) firstCat.set(e.id, cat.name);
      else if (seen !== cat.name) shared.add(e.id);
    }
  }
  return shared;
}
