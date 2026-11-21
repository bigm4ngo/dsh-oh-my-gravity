/** Antigravity's mark (the arch from the product's own favicon), drawn in the element's text colour. */
export const MANGO_PATH =
  "M14.02 19.5C17.9 19.22 21.07 15.31 19.12 11.12C16.88 6.64 11.39 3.35 8.24 3.09C6.35 3.02 5.94 5.11 5.46 7.46C4.48 12.18 8.31 19.21 14.02 19.5ZM12.88 19.12C13.75 20.23 14.42 20.99 14.83 21.91C15.79 21.36 16.57 20.91 16.28 20.61C15.78 19.75 15.55 18.95 14.98 18.36ZM15.19 20.32C17.23 21.45 20.3 20.37 21.53 18.51C19.49 17.37 16.42 18.45 15.19 20.32Z";

export function createMangoSvg(size = 16, className = ""): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", MANGO_PATH);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

const CSS = String.raw`
.omg { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); }
.omg-card { border: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .2)); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1, transparent); }
.omg-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.omg-dim { color: var(--dsw-alias-label-secondary, rgb(127 127 127)); font-size: 12px; line-height: 1.5; }
.omg-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .15)); }
.omg-row:first-of-type { border-top: 0; }
.omg-row code { font-size: 12px; }
.omg-good { color: var(--dsw-alias-state-success-primary, #16a34a); }
.omg-warn { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.omg-bad { color: var(--dsw-alias-state-error-primary, #dc2626); }
.omg-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; position: relative; cursor: pointer; flex: none; background: rgb(127 127 127 / .35); transition: background .15s; }
.omg-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
.omg-switch:checked { background: var(--dsw-alias-brand-primary, #4f46e5); }
.omg-switch:checked::after { transform: translateX(14px); }
.omg-switch:disabled { opacity: .45; cursor: not-allowed; }
.omg-btn { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgb(127 127 127 / .35)); background: transparent; color: inherit; }
.omg-quota-item { display: flex; flex-direction: column; gap: 5px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .15)); }
.omg-quota-item:first-of-type { border-top: 0; }
.omg-quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.omg-quota-val { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12px; }
.omg-quota-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l1, rgb(127 127 127 / .2)); overflow: hidden; }
.omg-quota-fill { height: 100%; border-radius: 2px; transition: width .2s ease; }
.omg-quota-meta { color: var(--dsw-alias-label-secondary, rgb(127 127 127)); font-size: 11px; line-height: 1.4; }
`;

/** Adds the stylesheet once; the returned function removes it. */
export function installStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.omg = "";
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
