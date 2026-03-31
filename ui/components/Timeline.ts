import type { TimelinePoint } from "../../shared/types";

export interface TimelineState {
  points: TimelinePoint[];
  selectedIndex: number;
  diffFromIndex: number | null;
}

export type TimelineCallback = (state: TimelineState) => void;

export function Timeline(
  points: TimelinePoint[],
  initialIndex: number,
  onChange: TimelineCallback
): HTMLElement {
  const state: TimelineState = {
    points,
    selectedIndex: initialIndex,
    diffFromIndex: null,
  };

  const el = document.createElement("div");
  el.className = "timeline-bar";

  if (points.length === 0) {
    el.innerHTML = `<div class="timeline-empty">No git history found</div>`;
    return el;
  }

  // Controls row
  const controls = document.createElement("div");
  controls.className = "timeline-controls";

  const info = document.createElement("span");
  info.className = "timeline-info";

  const diffToggle = document.createElement("button");
  diffToggle.className = "timeline-btn";
  diffToggle.textContent = "Diff mode";

  const resetBtn = document.createElement("button");
  resetBtn.className = "timeline-btn";
  resetBtn.textContent = "HEAD";

  controls.appendChild(info);
  controls.appendChild(diffToggle);
  controls.appendChild(resetBtn);

  // Slider track
  const track = document.createElement("div");
  track.className = "timeline-track";

  const filled = document.createElement("div");
  filled.className = "timeline-filled";
  track.appendChild(filled);

  const diffFilled = document.createElement("div");
  diffFilled.className = "timeline-diff-range";
  track.appendChild(diffFilled);

  // Commit markers
  const markers = document.createElement("div");
  markers.className = "timeline-markers";

  // We show a subset of markers if there are many commits
  const maxMarkers = 60;
  const step = Math.max(1, Math.floor(points.length / maxMarkers));

  for (let i = 0; i < points.length; i++) {
    if (i % step !== 0 && i !== points.length - 1 && i !== state.selectedIndex) continue;

    const p = points[i];
    const pct = points.length > 1 ? (i / (points.length - 1)) * 100 : 50;

    const marker = document.createElement("div");
    marker.className = "timeline-marker";
    marker.style.left = `${pct}%`;
    marker.dataset.index = String(i);

    // Annotation detection
    const msg = p.message.toLowerCase();
    if (msg.includes("fatality") || msg.includes("fatal")) {
      marker.classList.add("marker-red");
    } else if (msg.includes("new axis") || msg.includes("blind spot")) {
      marker.classList.add("marker-yellow");
    } else if (msg.includes("prune") || msg.includes("retire")) {
      marker.classList.add("marker-cyan");
    }

    // Tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "timeline-tooltip";
    const dateStr = new Date(p.date).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    tooltip.innerHTML = `
      <div class="tt-hash">${p.hash.slice(0, 7)}</div>
      <div class="tt-msg">${escapeHtml(p.message)}</div>
      <div class="tt-date">${dateStr}</div>
      ${p.filesChanged.length > 0 ? `<div class="tt-files">${p.filesChanged.length} files</div>` : ""}
    `;
    marker.appendChild(tooltip);

    marker.addEventListener("click", () => {
      const idx = parseInt(marker.dataset.index!);
      if (state.diffFromIndex !== null) {
        // In diff mode — second click sets the range end
        state.selectedIndex = idx;
        onChange(state);
      } else {
        state.selectedIndex = idx;
        onChange(state);
      }
      update();
    });

    markers.appendChild(marker);
  }

  track.appendChild(markers);

  // Range input for smooth sliding
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "timeline-slider";
  slider.min = "0";
  slider.max = String(points.length - 1);
  slider.value = String(state.selectedIndex);

  slider.addEventListener("input", () => {
    state.selectedIndex = parseInt(slider.value);
    update();
  });

  slider.addEventListener("change", () => {
    state.selectedIndex = parseInt(slider.value);
    onChange(state);
    update();
  });

  // Diff mode toggle
  let diffMode = false;
  diffToggle.addEventListener("click", () => {
    diffMode = !diffMode;
    if (diffMode) {
      state.diffFromIndex = Math.max(0, state.selectedIndex - 1);
      diffToggle.classList.add("active");
    } else {
      state.diffFromIndex = null;
      diffToggle.classList.remove("active");
    }
    onChange(state);
    update();
  });

  // Reset to HEAD
  resetBtn.addEventListener("click", () => {
    state.selectedIndex = 0; // points[0] is most recent
    state.diffFromIndex = null;
    diffMode = false;
    diffToggle.classList.remove("active");
    slider.value = "0";
    onChange(state);
    update();
  });

  function update() {
    slider.value = String(state.selectedIndex);
    const pct = points.length > 1
      ? (state.selectedIndex / (points.length - 1)) * 100
      : 50;
    filled.style.width = `${pct}%`;

    const current = points[state.selectedIndex];
    if (current) {
      const dateStr = new Date(current.date).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      if (state.diffFromIndex !== null) {
        const from = points[state.diffFromIndex];
        info.textContent = `Diff: ${from.hash.slice(0, 7)} → ${current.hash.slice(0, 7)}`;
      } else {
        info.textContent = `${current.hash.slice(0, 7)} — ${current.message.slice(0, 60)} — ${dateStr}`;
      }
    }

    // Update diff range highlight
    if (state.diffFromIndex !== null) {
      const fromPct = points.length > 1
        ? (state.diffFromIndex / (points.length - 1)) * 100
        : 0;
      const toPct = pct;
      const left = Math.min(fromPct, toPct);
      const width = Math.abs(toPct - fromPct);
      diffFilled.style.left = `${left}%`;
      diffFilled.style.width = `${width}%`;
      diffFilled.style.display = "block";
    } else {
      diffFilled.style.display = "none";
    }

    // Highlight active marker
    markers.querySelectorAll(".timeline-marker").forEach((m) => {
      const mEl = m as HTMLElement;
      const idx = parseInt(mEl.dataset.index!);
      mEl.classList.toggle("active", idx === state.selectedIndex);
      mEl.classList.toggle(
        "diff-from",
        state.diffFromIndex !== null && idx === state.diffFromIndex
      );
    });
  }

  el.appendChild(controls);
  el.appendChild(slider);
  el.appendChild(track);

  // Initial update
  update();

  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
