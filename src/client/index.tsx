/** dsh-oh-my-gravity, browser half: Settings page + Antigravity quota in the context meter. */
import { useEffect } from "react";
import { Section } from "./Section.js";
import { createMangoSvg, installStyles } from "./styles.js";
import { watchContextMeter, type MeterClientCtx } from "./context-meter.js";

export const inject = ["slots", "sessions", "modelDirectories"];

const LABEL = "Oh My Gravity";

/** DSH draws a gear for every settings page it has no glyph for, and the slot has no icon field. `settings.action`
 *  mounts whenever the dialog opens, so a renderless entry there swaps the gear in our row for the mark. */
function NavIcon() {
  useEffect(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"] nav button')]
      .find((button) => button.textContent?.trim() === LABEL);
    const gear = row?.querySelector("svg");
    if (!gear || gear.hasAttribute("data-omg-mark")) return;
    const svg = createMangoSvg(16, gear.getAttribute("class") ?? "");
    svg.setAttribute("data-omg-mark", "");
    gear.replaceWith(svg);
  });
  return null;
}

interface ClientContext extends MeterClientCtx {
  slots: {
    inject: (name: string, callback: () => unknown) => unknown;
    register: (definition: Record<string, unknown>, component: unknown) => unknown;
  };
  effect: (fn: () => unknown, label?: string) => void;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(), "dsh-oh-my-gravity: styles");
  ctx.effect(() => watchContextMeter(ctx), "dsh-oh-my-gravity: context meter");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({ name: "settings.section", id: "oh-my-gravity", order: 15, label: () => LABEL }, Section));
  ctx.slots.inject("settings.action", () =>
    ctx.slots.register({ name: "settings.action", id: "oh-my-gravity-nav-icon", order: 99, inject: () => ({}) }, NavIcon));
}
