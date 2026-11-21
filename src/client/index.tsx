/** dsh-oh-my-gravity, browser half: one Settings page. All data comes from the plugin's own routes. */
import { useEffect } from "react";
import { Section } from "./Section.js";
import { installStyles } from "./styles.js";

export const inject = ["slots"];

const LABEL = "Oh My Gravity";
/** Antigravity's mark (the arch from the product's own favicon), drawn in the row's text colour. */
const MARK = "M14.02 19.5C17.9 19.22 21.07 15.31 19.12 11.12C16.88 6.64 11.39 3.35 8.24 3.09C6.35 3.02 5.94 5.11 5.46 7.46C4.48 12.18 8.31 19.21 14.02 19.5ZM12.88 19.12C13.75 20.23 14.42 20.99 14.83 21.91C15.79 21.36 16.57 20.91 16.28 20.61C15.78 19.75 15.55 18.95 14.98 18.36ZM15.19 20.32C17.23 21.45 20.3 20.37 21.53 18.51C19.49 17.37 16.42 18.45 15.19 20.32Z";

/** DSH draws a gear for every settings page it has no glyph for, and the slot has no icon field. `settings.action`
 *  mounts whenever the dialog opens, so a renderless entry there swaps the gear in our row for the mark. */
function NavIcon() {
  useEffect(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"] nav button')]
      .find((button) => button.textContent?.trim() === LABEL);
    const gear = row?.querySelector("svg");
    if (!gear || gear.hasAttribute("data-omg-mark")) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("class", gear.getAttribute("class") ?? "");
    svg.setAttribute("data-omg-mark", "");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", MARK);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    gear.replaceWith(svg);
  });
  return null;
}

interface ClientContext {
  slots: {
    inject: (name: string, callback: () => unknown) => unknown;
    register: (definition: Record<string, unknown>, component: unknown) => unknown;
  };
  effect: (fn: () => unknown, label?: string) => void;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(), "dsh-oh-my-gravity: styles");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({ name: "settings.section", id: "oh-my-gravity", order: 15, label: () => LABEL }, Section));
  ctx.slots.inject("settings.action", () =>
    ctx.slots.register({ name: "settings.action", id: "oh-my-gravity-nav-icon", order: 99, inject: () => ({}) }, NavIcon));
}
