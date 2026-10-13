import { sb, callFn } from "./supabase.js";
import { $, $$, esc, inr, fmtDate, badge, toast, loading, banner, busy, confirmModal } from "./ui.js";

const STATUSES = ["upcoming", "open", "full", "completed", "cancelled"];
const one = (x) => (Array.isArray(x) ? x[0] : x);

/* ---------------------------------------------------------------- Admin home */
export async function viewAdmin(root, ctx) {
  if (!ctx.isAdmin) { root.innerHTML = banner("Admin access required.", "error"); return; }
  let tab = "tournaments";
  const draw = async () => {
    root.innerHTML = `<div class="page-head"><h1>Admin dashboard</h1></div>
      <div class="tabs">${[["tournaments", "Tournaments"], ["refunds", "Refunds due"], ["payments", "Payments"]]
        .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <div id="pane"></div>`;
    $$("[data-tab]", root).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; draw(); }));
    const pane = $("#pane", root);
    if (tab === "tournaments") await tournamentsPane(pane);
    else if (tab === "refunds") await refundsPane(pane);
    else await paymentsPane(pane);
  };
  await draw();
}

async function tournamentsPane(pane) {
  loading(pane);
  const { data, error } = await sb.from("tournaments").select("*, slots(status)").order("created_at", { ascending: false });
  if (error) { pane.innerHTML = banner(error.message, "error"); return; }
  pane.innerHTML = `
    <form class="card stack" id="create" style="margin-bottom:16px">
      <h3>Create tournament</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div><label>Name</label><input id="n" maxlength="80" required></div>
        <div><label>Mode</label><select id="m"><option>Lone Wolf</option><option>Full Map</option><option>CS</option></select></div>
        <div><label>Match time</label><input id="t" type="datetime-local"></div>
        <div><label>Start as</label><select id="s"><option value="open">Open</option><option value="upcoming">Upcoming</option></select></div>
      </div>
      <p class="muted small">Lone Wolf ₹30 · 2 players · ₹50 prize. Full Map ₹40 · 50 players · ₹32/verified kill. CS ₹30 · 8 players · ₹50 prize. Slots are generated automatically.</p>
      <button class="btn" type="submit">Create</button>
    </form>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Mode</th><th>Status</th><th>Slots</th><th>Match time</th><th></th></tr></thead><tbody>
    ${data.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.mode)}</td><td>${badge(t.status)}</td>
      <td>${t.slots.filter((s) => s.status === "booked").length}/${t.slots.length}</td><td>${esc(fmtDate(t.match_time))}</td>
      <td><a class="btn sm ghost" href="#/admin/t/${t.id}">Manage</a></td></tr>`).join("") || '<tr><td colspan="6" class="muted">No tournaments yet</td></tr>'}
    </tbody></table></div></div>`;
  $("#create", pane).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    await busy($("button", f), async () => {
      try {
        const tv = $("#t", f).value;
        await callFn("admin-action", { action: "create_tournament", name: $("#n", f).value, mode: $("#m", f).value,
          status: $("#s", f).value, match_time: tv ? new Date(tv).toISOString() : null });
        toast("Tournament created");
        await tournamentsPane(pane);
      } catch (err) { toast(err.message, "error"); }
    });
  };
}

async function refundsPane(pane) {
  loading(pane);
  const { data, error } = await sb.from("payments")
    .select("*, profiles(game_name, phone_number), bookings!inner(booking_status, tournaments(name))")
    .eq("payment_status", "successful").eq("bookings.booking_status", "cancelled");
  if (error) { pane.innerHTML = banner(error.message, "error"); return; }
  pane.innerHTML = `<div class="card stack"><p class="muted small">Successful payments whose booking was cancelled (cancelled tournament or slot lost after expiry). Refund them in the Paytm dashboard, then mark them refunded here.</p>
    <div class="table-wrap"><table><thead><tr><th>Player</th><th>Phone</th><th>Tournament</th><th>Amount</th><th>Paytm txn</th><th></th></tr></thead><tbody>
    ${data.map((p) => `<tr><td>${esc(p.profiles?.game_name)}</td><td>${esc(p.profiles?.phone_number)}</td><td>${esc(p.bookings?.tournaments?.name)}</td>
      <td>${inr(p.amount)}</td><td>${esc(p.provider_transaction_id)}</td><td><button class="btn sm" data-r="${p.id}">Mark refunded</button></td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">No refunds due</td></tr>'}</tbody></table></div></div>`;
  $$("[data-r]", pane).forEach((b) => (b.onclick = async () => {
    if (!(await confirmModal({ title: "Mark as refunded?", body: "Only do this after refunding via Paytm." }))) return;
    try { await callFn("admin-action", { action: "mark_refunded", payment_id: b.dataset.r }); toast("Marked refunded"); await refundsPane(pane); }
    catch (err) { toast(err.message, "error"); }
  }));
}

async function paymentsPane(pane) {
  loading(pane);
  const { data, error } = await sb.from("payments")
    .select("*, profiles(game_name)").order("created_at", { ascending: false }).limit(100);
  if (error) { pane.innerHTML = banner(error.message, "error"); return; }
  pane.innerHTML = `<div class="card"><div class="table-wrap"><table><thead><tr><th>When</th><th>Player</th><th>Amount</th><th>Order</th><th>Status</th></tr></thead><tbody>
    ${data.map((p) => `<tr><td>${esc(fmtDate(p.created_at))}</td><td>${esc(p.profiles?.game_name)}</td><td>${inr(p.amount)}</td>
      <td>${esc(p.provider_order_id)}</td><td>${badge(p.payment_status)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No payments</td></tr>'}
    </tbody></table></div></div>`;
}

/* ---------------------------------------------------------------- Manage one tournament */
export async function viewAdminTournament(root, ctx, [id]) {
  if (!ctx.isAdmin) { root.innerHTML = banner("Admin access required.", "error"); return; }
  loading(root);
  const [{ data: t }, { data: room }, { data: bookings, error }] = await Promise.all([
    sb.from("tournaments").select("*").eq("id", id).maybeSingle(),
    sb.from("room_credentials").select("*").eq("tournament_id", id).maybeSingle(),
    sb.from("bookings").select("*, profiles(game_name, phone_number), slots(slot_number), match_results(*)")
      .eq("tournament_id", id).in("booking_status", ["confirmed", "completed"]).order("created_at"),
  ]);
  if (!t || error) { root.innerHTML = banner("Tournament not found.", "error"); return; }
  const fullMap = t.mode === "Full Map";

  root.innerHTML = `<a class="small" href="#/admin">← Admin</a>
    <div class="page-head" style="margin-top:8px"><div class="row">${badge(t.mode, "mode")}${badge(t.status)}</div><h1>${esc(t.name)}</h1></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <form class="card stack" id="st"><h3>Status</h3>
        <select id="s">${STATUSES.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <p class="muted small">Completing marks confirmed bookings completed. Cancelling cancels bookings and hides the room; refunds then appear under "Refunds due".</p>
        <button class="btn" type="submit">Apply</button></form>
      <form class="card stack" id="rm"><h3>Room credentials</h3>
        <div><label>Room ID</label><input id="rid" value="${esc(room?.room_id ?? "")}" required></div>
        <div><label>Room password</label><input id="rpw" value="${esc(room?.room_password ?? "")}" required></div>
        <label class="check"><input type="checkbox" id="pub" ${room?.published ? "checked" : ""}><span>Publish to confirmed players</span></label>
        <button class="btn" type="submit">Save</button></form>
    </div>
    <div class="card stack" style="margin-top:16px"><h3>Participants &amp; results</h3>
      <p class="muted small">${fullMap ? `Reward = verified kills × ${inr(t.kill_reward)}.` : `Winner receives ${inr(t.winner_prize)}.`} Enter kills, then Approve.</p>
      <div class="table-wrap"><table><thead><tr><th>Slot</th><th>Player</th><th>Phone</th><th>Kills</th><th>Winner</th><th>Reward</th><th></th></tr></thead><tbody>
      ${bookings.map((b) => { const r = one(b.match_results); return `<tr data-b="${b.id}">
        <td>#${esc(b.slots.slot_number)}</td><td>${esc(b.profiles?.game_name)}</td><td>${esc(b.profiles?.phone_number)}</td>
        <td><input type="number" min="0" max="100" value="${r?.kills ?? 0}" class="k"></td>
        <td><input type="checkbox" class="w" ${r?.winner ? "checked" : ""}></td>
        <td>${r ? inr(r.reward_amount) + (r.verified ? " ✔" : "") : "—"}</td>
        <td><button class="btn sm ap">Approve</button></td></tr>`; }).join("") || '<tr><td colspan="7" class="muted">No confirmed participants yet</td></tr>'}
      </tbody></table></div></div>`;

  $("#st", root).onsubmit = async (e) => {
    e.preventDefault();
    const status = $("#s", root).value;
    if (status === "cancelled" && !(await confirmModal({ title: "Cancel tournament?", body: "All bookings will be cancelled and players must be refunded." }))) return;
    await busy($("button", e.currentTarget), async () => {
      try { await callFn("admin-action", { action: "set_status", tournament_id: id, status }); toast("Status updated"); await viewAdminTournament(root, ctx, [id]); }
      catch (err) { toast(err.message, "error"); }
    });
  };
  $("#rm", root).onsubmit = async (e) => {
    e.preventDefault();
    await busy($("button", e.currentTarget), async () => {
      try {
        await callFn("admin-action", { action: "set_room", tournament_id: id, room_id: $("#rid", root).value,
          room_password: $("#rpw", root).value, published: $("#pub", root).checked });
        toast("Room credentials saved");
      } catch (err) { toast(err.message, "error"); }
    });
  };
  $$(".ap", root).forEach((btn) => (btn.onclick = () => busy(btn, async () => {
    const tr = btn.closest("tr");
    try {
      const res = await callFn("approve-results", { booking_id: tr.dataset.b, kills: Number($(".k", tr).value || 0),
        winner: $(".w", tr).checked, verified: true });
      toast(`Approved. Reward ${inr(res.reward_amount)}`);
      await viewAdminTournament(root, ctx, [id]);
    } catch (err) { toast(err.message, "error"); }
  })));
}
