import { sb } from "./supabase.js";
import { $, esc, toast, loading, banner } from "./ui.js";
import { viewLogin, viewRegister, viewForgot, viewReset } from "./auth.js";
import { viewDashboard, viewTournament, viewPay, viewPaymentResult, viewBookings, viewRoom, viewResults } from "./views.js";
import { viewAdmin, viewAdminTournament } from "./admin.js";

const PUBLIC = new Set(["login", "register", "forgot"]);
const routes = [
  ["login", /^\/login$/, viewLogin], ["register", /^\/register$/, viewRegister],
  ["forgot", /^\/forgot$/, viewForgot], ["reset", /^\/reset$/, viewReset],
  ["home", /^\/?$/, viewDashboard],
  ["tournament", /^\/tournament\/([\w-]+)$/, viewTournament],
  ["pay", /^\/pay\/([\w-]+)$/, viewPay],
  ["payment-result", /^\/payment-result$/, viewPaymentResult],
  ["bookings", /^\/bookings$/, viewBookings],
  ["room", /^\/room\/([\w-]+)$/, viewRoom],
  ["results", /^\/results$/, viewResults],
  ["admin", /^\/admin$/, viewAdmin],
  ["admin", /^\/admin\/t\/([\w-]+)$/, viewAdminTournament],
];

const ctx = { user: null, profile: null, isAdmin: false };
let cleanup = null;
let renderId = 0;
const app = $("#app");

async function loadContext(session) {
  ctx.user = session?.user ?? null;
  ctx.profile = null; ctx.isAdmin = false;
  if (!ctx.user) return;
  const [{ data: p }, { data: a }] = await Promise.all([
    sb.from("profiles").select("*").eq("id", ctx.user.id).maybeSingle(),
    sb.from("admin_roles").select("role").eq("user_id", ctx.user.id).maybeSingle(),
  ]);
  ctx.profile = p; ctx.isAdmin = !!a;
}

function renderNav(active) {
  const loggedIn = !!ctx.user;
  const links = loggedIn ? [
    ["home", "#/", "Tournaments", "🎮"], ["bookings", "#/bookings", "Bookings", "🎟️"], ["results", "#/results", "Results", "🏆"],
    ...(ctx.isAdmin ? [["admin", "#/admin", "Admin", "🛠️"]] : []),
  ] : [];
  $("#topnav").innerHTML = links.map(([k, h, l]) => `<a href="${h}" class="${active === k ? "active" : ""}">${l}</a>`).join("");
  const bn = $("#bottomnav");
  bn.innerHTML = links.map(([k, h, l, i]) => `<a href="${h}" class="${active === k ? "active" : ""}"><span>${i}</span>${l}</a>`).join("");
  bn.classList.toggle("hidden", !loggedIn);
  $("#logoutBtn").classList.toggle("hidden", !loggedIn);
}

async function render() {
  const id = ++renderId;
  if (typeof cleanup === "function") { try { cleanup(); } catch (_) {} cleanup = null; }

  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const query = new URLSearchParams(qs || "");
  const match = routes.map(([name, re, fn]) => ({ name, m: path.match(re), fn })).find((r) => r.m);
  if (!match) { location.hash = "#/"; return; }

  // route protection: unauthenticated users cannot reach any booking feature
  if (!ctx.user && !PUBLIC.has(match.name)) { location.hash = "#/login"; return; }
  if (ctx.user && PUBLIC.has(match.name)) { location.hash = "#/"; return; }

  renderNav(match.name);
  loading(app);
  try {
    const out = await match.fn(app, ctx, match.m.slice(1), query);
    if (id === renderId) cleanup = out; else if (typeof out === "function") out();
  } catch (e) {
    console.error(e);
    app.innerHTML = banner("Something went wrong: " + e.message, "error");
  }
  window.scrollTo(0, 0);
}

$("#logoutBtn").onclick = async () => {
  await sb.auth.signOut();
  toast("Logged out");
  location.hash = "#/login";
};

let initialised = false;
sb.auth.onAuthStateChange(async (event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    await loadContext(session);
    location.hash = "#/reset";
    return render();
  }
  if (event === "TOKEN_REFRESHED") { ctx.user = session?.user ?? ctx.user; return; }
  if (!initialised) return; // initial session handled below
  if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) {
    // defer: do not call supabase APIs inside the callback
    setTimeout(async () => { await loadContext(session); render(); }, 0);
  }
});

window.addEventListener("hashchange", render);

(async function boot() {
  if (!window.APP_CONFIG || window.APP_CONFIG.SUPABASE_URL.includes("YOUR-PROJECT")) {
    app.innerHTML = banner("Set SUPABASE_URL and SUPABASE_ANON_KEY in web/js/config.js (see SETUP.md).", "error");
    return;
  }
  const { data } = await sb.auth.getSession();
  await loadContext(data.session);
  initialised = true;
  // strip ?code= left by email links, keep hash route
  if (location.search.includes("code=") || location.search.includes("error")) {
    history.replaceState(null, "", location.pathname + (location.hash || "#/"));
  }
  render();
})();
