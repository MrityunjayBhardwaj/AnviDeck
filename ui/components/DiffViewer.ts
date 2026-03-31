export function DiffViewer(diff: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="card-header"><h2>Diff</h2></div>`;

  const body = document.createElement("div");
  body.className = "card-body";

  if (!diff.trim()) {
    body.innerHTML = `<div class="empty">No changes between selected commits</div>`;
    el.appendChild(body);
    return el;
  }

  const pre = document.createElement("pre");
  pre.className = "diff-content";

  const lines = diff.split("\n");
  for (const line of lines) {
    const span = document.createElement("span");
    span.textContent = line + "\n";

    if (line.startsWith("+++") || line.startsWith("---")) {
      span.className = "diff-file";
    } else if (line.startsWith("@@")) {
      span.className = "diff-hunk";
    } else if (line.startsWith("+")) {
      span.className = "diff-add";
    } else if (line.startsWith("-")) {
      span.className = "diff-del";
    } else if (line.startsWith("diff ")) {
      span.className = "diff-header";
    }

    pre.appendChild(span);
  }

  body.appendChild(pre);
  el.appendChild(body);
  return el;
}
