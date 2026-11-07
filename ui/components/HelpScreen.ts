/**
 * Help · Example flows (#91): the prototype's six flows, each with its steps and the screens it
 * opens, and Play. Playing opens the real screens on the picked project; see ui/shell/tour.ts.
 */
import { FLOWS, flowScreens } from "../shell/tour-model";
import { screen } from "../shell/routes";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function HelpScreen(play: (flow: number) => void): HTMLElement {
  if (!document.querySelector("link[data-help-css]")) {
    const l = el("link");
    l.rel = "stylesheet";
    l.href = "/styles/help.css";
    l.dataset.helpCss = "";
    document.head.appendChild(l);
  }
  const wrap = el("section", "sh-screen ht");
  wrap.dataset.screen = "flows";
  const head = el("div", "sh-head");
  head.append(el("h1", "", "Usage flows, end to end"), el("span", "sh-sub", "each one walks through the real screens; press Play"));
  wrap.append(head);
  wrap.append(
    el(
      "p",
      "sh-dim ht-intro",
      `Each flow opens the real screens on the project picked above and points at what to look at. It only opens screens and highlights: it never presses Start agent, Merge, Allow, Right or Wrong. A step whose data is not on the screen is skipped, and the card says why: no such data, the screen's own reason, or the screen did not show it in time.`,
    ),
  );
  const list = el("div", "ht-list");
  FLOWS.forEach((f, i) => {
    const card = el("div", "sh-card ht-flowcard");
    card.dataset.flow = String(i);
    const top = el("div", "ht-row");
    const btn = el("button", "sh-btn ht-play", "▶ Play");
    btn.type = "button";
    btn.dataset.play = String(i);
    btn.addEventListener("click", () => play(i));
    top.append(el("h2", "", f.name), btn);
    const ol = el("ol", "ht-steps");
    for (const s of f.steps) ol.append(el("li", "", s.title));
    const screens = el("div", "sh-dim ht-screens", `Screens: ${flowScreens(f).map((id) => screen(id).label).join(" → ")}`);
    card.append(top, ol, screens);
    list.append(card);
  });
  wrap.append(list);
  return wrap;
}
