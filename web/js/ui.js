export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const inr = (n) => "₹" + Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const fmtDate = (d) => d
  ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "To be announced";
export const badge = (s, cls = s) => `<span class="badge ${esc(cls)}">${esc(s)}</span>`;

export function toast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), type === "error" ? 6000 : 3500);
}

export const loading = (root) => { root.innerHTML = '<div class="spinner" aria-label="Loading"></div>'; };
export const banner = (msg, type = "warn") => `<div class="banner ${type}">${esc(msg)}</div>`;

/** Disables a button and shows a spinner while an async fn runs. */
export async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

export function confirmModal({ title, body, confirmText = "Confirm" }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="card modal stack"><h3>${esc(title)}</h3><div class="muted">${body}</div>
      <div class="row"><button class="btn" data-ok>${esc(confirmText)}</button><button class="btn ghost" data-no>Cancel</button></div></div>`;
    document.body.appendChild(back);
    const done = (v) => { back.remove(); resolve(v); };
    $("[data-ok]", back).onclick = () => done(true);
    $("[data-no]", back).onclick = () => done(false);
    back.onclick = (e) => { if (e.target === back) done(false); };
  });
}

export function setFieldError(input, msg) {
  input.classList.toggle("invalid", !!msg);
  const e = input.closest("div")?.querySelector(".err");
  if (e) e.textContent = msg || "";
}

export function prizeText(t) {
  if (t.mode === "Full Map") return `${inr(t.kill_reward)} per verified kill`;
  return `Winner takes ${inr(t.winner_prize)}`;
}
