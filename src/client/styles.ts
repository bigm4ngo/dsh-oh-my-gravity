const CSS = String.raw`
.omg { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); }
.omg-card { border: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .2)); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1, transparent); }
.omg-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.omg-dim { color: var(--dsw-alias-label-secondary, rgb(127 127 127)); font-size: 12px; line-height: 1.5; }
.omg-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .15)); }
.omg-row:first-of-type { border-top: 0; }
.omg-row code { font-size: 12px; }
.omg-good { color: var(--dsw-alias-state-success-primary, #16a34a); }
.omg-bad { color: var(--dsw-alias-state-error-primary, #dc2626); }
.omg-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; position: relative; cursor: pointer; flex: none; background: rgb(127 127 127 / .35); transition: background .15s; }
.omg-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
.omg-switch:checked { background: var(--dsw-alias-brand-primary, #4f46e5); }
.omg-switch:checked::after { transform: translateX(14px); }
.omg-switch:disabled { opacity: .45; cursor: not-allowed; }
.omg-btn { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgb(127 127 127 / .35)); background: transparent; color: inherit; }
`;

/** Adds the stylesheet once; the returned function removes it. */
export function installStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.omg = "";
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
