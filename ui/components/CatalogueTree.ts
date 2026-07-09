import type { Catalogue, CatalogueEntry } from "../../shared/types";

export function CatalogueTree(catalogues: Catalogue[]): HTMLElement {
  const el = document.createElement("div");

  if (catalogues.length === 0) {
    el.innerHTML = `<div class="empty">No catalogues found</div>`;
    return el;
  }

  const ungroundedTotal = catalogues.reduce(
    (s, c) => s + c.entries.filter((e) => !e.grounded).length,
    0
  );

  let ungroundedOnly = false;

  // Filter bar — "show ungrounded only" toggle
  const filterBar = document.createElement("div");
  filterBar.className = "catalogue-filter";
  const toggle = document.createElement("button");
  toggle.className = "catalogue-filter-toggle";
  const groups = document.createElement("div");
  groups.className = "catalogue-groups";

  function renderGroups() {
    groups.innerHTML = "";
    const visible = ungroundedOnly
      ? catalogues
          .map((c) => ({ ...c, entries: c.entries.filter((e) => !e.grounded) }))
          .filter((c) => c.entries.length > 0)
      : catalogues;
    if (visible.length === 0) {
      groups.innerHTML = `<div class="empty">No ungrounded entries — all grounded.</div>`;
      return;
    }
    for (const cat of visible) {
      groups.appendChild(CatalogueGroup(cat, ungroundedOnly));
    }
  }

  function renderToggle() {
    toggle.classList.toggle("active", ungroundedOnly);
    toggle.setAttribute("aria-pressed", String(ungroundedOnly));
    toggle.innerHTML = `<span class="filter-dot"></span>Show ungrounded only <span class="filter-count">${ungroundedTotal}</span>`;
  }

  toggle.addEventListener("click", () => {
    ungroundedOnly = !ungroundedOnly;
    renderToggle();
    renderGroups();
  });

  renderToggle();
  filterBar.appendChild(toggle);
  el.appendChild(filterBar);

  renderGroups();
  el.appendChild(groups);

  return el;
}

function CatalogueGroup(catalogue: Catalogue, expanded = false): HTMLElement {
  const group = document.createElement("div");
  group.className = "catalogue-group";

  const header = document.createElement("div");
  header.className = "catalogue-header";
  header.innerHTML = `
    <span class="arrow${expanded ? " open" : ""}">▸</span>
    <span class="cat-name">${catalogue.name}</span>
    <span class="cat-count">${catalogue.entries.length}</span>
  `;

  const entriesEl = document.createElement("div");
  entriesEl.className = "catalogue-entries";
  entriesEl.style.display = expanded ? "block" : "none";

  for (const entry of catalogue.entries) {
    entriesEl.appendChild(EntryItem(entry));
  }

  header.addEventListener("click", () => {
    const arrow = header.querySelector(".arrow")!;
    const isOpen = entriesEl.style.display !== "none";
    entriesEl.style.display = isOpen ? "none" : "block";
    arrow.classList.toggle("open", !isOpen);
  });

  group.appendChild(header);
  group.appendChild(entriesEl);
  return group;
}

function EntryItem(entry: CatalogueEntry): HTMLElement {
  const item = document.createElement("div");
  item.className = `catalogue-entry${!entry.grounded ? " entry-ungrounded" : ""}`;

  const header = document.createElement("div");
  header.className = "entry-header";

  const tagsHtml = entry.tags
    .map((t) => {
      const cls = tagClass(t);
      return `<span class="tag ${cls}">${t}</span>`;
    })
    .join("");

  header.innerHTML = `
    <span class="entry-id">${entry.id}</span>
    <span class="entry-title">${entry.title}</span>
    <span class="entry-tags">${tagsHtml}</span>
  `;

  const detail = document.createElement("div");
  detail.className = "entry-detail";
  detail.style.display = "none";

  let detailHtml = "";
  for (const [key, value] of Object.entries(entry.sections)) {
    // REF is rendered explicitly below with grounding styling — the parser leaves
    // it in sections too, so skip it here to avoid a duplicate line.
    if (key === "REF") continue;
    detailHtml += `<div class="section"><span class="section-key">${key}:</span><span class="section-value">${escapeHtml(value)}</span></div>`;
  }

  if (entry.ref) {
    detailHtml += `<div class="section entry-ref-line"><span class="section-key">REF:</span><span class="section-value ref-value">${escapeHtml(entry.ref)}</span></div>`;
  } else {
    detailHtml += `<div class="section entry-ref-line"><span class="section-key">REF:</span><span class="section-value ref-missing">UNGROUNDED</span></div>`;
  }

  if (entry.origin || entry.why || entry.how) {
    detailHtml += `<div class="provenance">`;
    if (entry.origin)
      detailHtml += `<div class="section"><span class="provenance-field">ORIGIN:</span> ${escapeHtml(entry.origin)}</div>`;
    if (entry.why)
      detailHtml += `<div class="section"><span class="provenance-field">WHY:</span> ${escapeHtml(entry.why)}</div>`;
    if (entry.how)
      detailHtml += `<div class="section"><span class="provenance-field">HOW:</span> ${escapeHtml(entry.how)}</div>`;
    detailHtml += `</div>`;
  }

  detail.innerHTML = detailHtml;

  header.addEventListener("click", () => {
    detail.style.display = detail.style.display === "none" ? "block" : "none";
  });

  item.appendChild(header);
  item.appendChild(detail);
  return item;
}

function tagClass(tag: string): string {
  if (tag === "FATALITY") return "fatality";
  if (tag === "MISALIGNED") return "misaligned";
  if (tag === "NOT YET IMPLEMENTED") return "not-implemented";
  if (tag === "ALIGNED") return "aligned";
  return "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
