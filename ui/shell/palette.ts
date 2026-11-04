/**
 * The ⌘K / Ctrl+K palette (#80). Entries come from palette-model.ts; this file only draws
 * them and handles keys. Pending entries are drawn but cannot be chosen.
 */
import { filterEntries, initialSelection, type PaletteEntry } from "./palette-model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PaletteDeps {
  entries: () => PaletteEntry[];
  /** Run a chosen entry (navigate, switch project, open a page). */
  choose: (e: PaletteEntry) => void;
}

export function createPalette(deps: PaletteDeps): { open: () => void; close: () => void; isOpen: () => boolean } {
  const bg = document.createElement("div");
  bg.className = "sh-palette-bg";
  bg.setAttribute("role", "dialog");
  bg.setAttribute("aria-modal", "true");
  bg.setAttribute("aria-label", "Command palette");
  bg.innerHTML = `<div class="sh-palette">
    <input type="text" placeholder="Type a screen, a project, an agent, or a command…" aria-label="Command" autocomplete="off" spellcheck="false">
    <div class="sh-res" role="listbox"></div>
    <div class="sh-pal-foot sh-dim">↑↓ to move · Enter to open · Esc to close</div>
  </div>`;
  document.body.appendChild(bg);
  const input = bg.querySelector("input")!;
  const res = bg.querySelector<HTMLElement>(".sh-res")!;
  let shown: PaletteEntry[] = [];
  let sel = 0;
  let restoreFocus: Element | null = null;

  const choosable = () => [...res.querySelectorAll<HTMLButtonElement>("button[data-pi]")];

  function paint() {
    shown = filterEntries(deps.entries(), input.value);
    let html = "";
    let group = "";
    shown.forEach((e, i) => {
      if (e.group !== group) {
        group = e.group;
        html += `<div class="sh-grp">${esc(group)}</div>`;
      }
      const hint = e.hint ? `<span class="sh-dim">${esc(e.hint)}</span>` : "";
      html += e.pending
        ? `<div class="sh-pal-item pending" aria-disabled="true"><span>${esc(e.label)}</span>${hint}<span class="sh-chip">arrives with ${esc(e.pending)}</span></div>`
        : `<button type="button" class="sh-pal-item" role="option" data-pi="${i}"><span>${esc(e.label)}</span>${hint}</button>`;
    });
    res.innerHTML = html || `<div class="sh-grp">No match</div>`;
    sel = initialSelection(shown, input.value);
    mark();
  }

  function mark() {
    const items = choosable();
    items.forEach((b, i) => {
      b.classList.toggle("sel", i === sel);
      b.setAttribute("aria-selected", String(i === sel));
    });
    items[sel]?.scrollIntoView({ block: "nearest" });
  }

  function run(btn: HTMLButtonElement | undefined) {
    if (!btn) return;
    const e = shown[+btn.dataset.pi!];
    close();
    deps.choose(e);
  }

  function open() {
    if (bg.classList.contains("on")) return;
    restoreFocus = document.activeElement;
    bg.classList.add("on");
    input.value = "";
    paint();
    input.focus();
  }
  function close() {
    if (!bg.classList.contains("on")) return;
    bg.classList.remove("on");
    (restoreFocus as HTMLElement | null)?.focus?.();
  }

  input.addEventListener("input", paint);
  res.addEventListener("click", (e) => run((e.target as Element).closest<HTMLButtonElement>("button[data-pi]") ?? undefined));
  bg.addEventListener("click", (e) => {
    if (e.target === bg) close();
  });
  input.addEventListener("keydown", (e) => {
    const n = choosable().length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      sel = (sel + 1) % n;
      mark();
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      sel = sel <= 0 ? n - 1 : sel - 1;
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(choosable()[sel]);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (bg.classList.contains("on")) close();
      else open();
    } else if (e.key === "Escape" && bg.classList.contains("on")) {
      close();
    }
  });

  return { open, close, isOpen: () => bg.classList.contains("on") };
}
