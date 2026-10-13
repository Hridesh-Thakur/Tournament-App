import { sb, callFn, RESERVATION_MINUTES } from "./supabase.js";
import { $, $$, esc, inr, fmtDate, badge, toast, loading, banner, busy, confirmModal, prizeText } from "./ui.js";

const fail = (root, msg) => { root.innerHTML = banner(msg, "error"); };

/* ------------------------------------------------------------------ Dashboard */
export async function viewDashboard(root, ctx) {
  loading(root);
  const { data, error } = await sb.from("tournaments")
    .select("*, slots(status)").in("status", ["upcoming", "open", "full"])
    .order("match_time", { ascending: true, nullsFirst: false });
  if (error) return fail(root, "Could not load tournaments: " + error.message);

  const unverified = !ctx.user.email_confirmed_at
    ? banner("Verify your email to book tournaments. Check your inbox for the link.", "warn") : "";
  root.innerHTML = `
    <div class="page-head"><h1>Tournaments</h1><p>Welcome, ${esc(ctx.profile?.game_name ?? "player")}. Pick a match and lock your slot.</p></div>
    ${unverified}
    ${data.length ? `<div class="grid">${data.map(card).join("")}</div>`
      : '<div class="empty card">No tournaments are open right now. Check back soon.</div>'}`;

  function card(t) {
    const total = t.slots.length, taken = t.slots.filter((s) => s.status !== "available").length;
    const pct = total ? Math.round((taken / total) * 100) : 0;
    return `<article class="card stack">
      <div class="row between">${badge(t.mode, "mode")}${badge(t.status)}</div>
      <h3>${esc(t.name)}</h3>
      <div>
        <div class="stat"><span>Entry fee</span><b>${inr(t.entry_fee)}</b></div>
        <div class="stat"><span>Prize</span><b>${esc(prizeText(t))}</b></div>
        <div class="stat"><span>Match time</span><b>${esc(fmtDate(t.match_time))}</b></div>
        <div class="stat"><span>Players</span><b>${taken}/${total}</b></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <a class="btn block" href="#/tournament/${t.id}">${t.status === "open" ? "Select slot" : "View"}</a>
    </article>`;
  }
}

/* ------------------------------------------------------------------ Slot selection */
export async function viewTournament(root, ctx, [id]) {
  loading(root);
  const [{ data: t, error }, { data: slots, error: e2 }, { data: mine }] = await Promise.all([
    sb.from("tournaments").select("*").eq("id", id).maybeSingle(),
    sb.from("slots").select("id, slot_number, status").eq("tournament_id", id).order("slot_number"),
    sb.from("bookings").select("id, booking_status, slots(slot_number)").eq("tournament_id", id)
      .in("booking_status", ["pending", "confirmed", "completed"]),
  ]);
  if (error || e2 || !t) return fail(root, "Tournament not found.");
  const myBooking = mine?.[0];
  let selected = null;

  const draw = () => {
    const open = t.status === "open";
    root.innerHTML = `
      <a class="small" href="#/">← All tournaments</a>
      <div class="page-head" style="margin-top:8px"><div class="row">${badge(t.mode, "mode")}${badge(t.status)}</div>
        <h1>${esc(t.name)}</h1>
        <p>${inr(t.entry_fee)} entry · ${esc(prizeText(t))} · ${esc(fmtDate(t.match_time))}</p></div>
      ${!ctx.user.email_confirmed_at ? banner("Verify your email before booking.", "warn") : ""}
      ${myBooking ? `<div class="banner ${myBooking.booking_status === "pending" ? "warn" : "ok"}">
        You have a ${esc(myBooking.booking_status)} booking (slot ${esc(myBooking.slots?.slot_number)}).
        <a href="${myBooking.booking_status === "pending" ? `#/pay/${myBooking.id}` : "#/bookings"}">
        ${myBooking.booking_status === "pending" ? "Complete payment" : "View my bookings"}</a></div>` : ""}
      ${!open ? banner(`Booking is not open (${t.status}).`, "warn") : ""}
      <div class="card stack">
        <div class="legend"><span><i style="background:var(--green)"></i>Available</span>
          <span><i style="background:var(--accent2)"></i>Reserved</span><span><i style="background:#555b78"></i>Booked</span></div>
        <div class="slots" id="slots">${slots.map((s) =>
          `<button class="slot ${s.status}${selected === s.id ? " selected" : ""}" data-id="${s.id}" data-n="${s.slot_number}"
            ${s.status !== "available" || !open || myBooking ? "disabled" : ""} aria-label="Slot ${s.slot_number} ${s.status}">${s.slot_number}</button>`).join("")}</div>
        <button class="btn block" id="book" ${selected ? "" : "disabled"}>${selected ? "Book slot & pay " + inr(t.entry_fee) : "Select a slot"}</button>
      </div>`;
    $$(".slot.available", root).forEach((b) => (b.onclick = () => { selected = b.dataset.id; draw(); }));
    const book = $("#book", root);
    book.onclick = async () => {
      const n = slots.find((s) => s.id === selected)?.slot_number;
      const ok = await confirmModal({
        title: `Reserve slot ${n}?`,
        body: `We'll hold it for ${RESERVATION_MINUTES} minutes while you pay ${inr(t.entry_fee)}.`,
        confirmText: "Reserve",
      });
      if (!ok) return;
      await busy(book, async () => {
        const { data: bookingId, error: err } = await sb.rpc("reserve_slot", { p_slot_id: selected });
        if (err) { toast(err.message, "error"); selected = null; await refreshSlots(); return; }
        location.hash = `#/pay/${bookingId}`;
      });
    };
  };

  async function refreshSlots() {
    const { data } = await sb.from("slots").select("id, slot_number, status").eq("tournament_id", id).order("slot_number");
    if (data) { slots.splice(0, slots.length, ...data); draw(); }
  }
  draw();

  // live updates while viewing
  const ch = sb.channel(`slots-${id}`).on("postgres_changes",
    { event: "*", schema: "public", table: "slots", filter: `tournament_id=eq.${id}` },
    () => { if (document.body.contains($("#slots", root))) refreshSlots(); }).subscribe();
  return () => sb.removeChannel(ch);
}

/* ------------------------------------------------------------------ Payment */
export async function viewPay(root, ctx, [bookingId]) {
  loading(root);
  const { data: b, error } = await sb.from("bookings")
    .select("*, tournaments(name, mode, match_time), slots(slot_number)").eq("id", bookingId).maybeSingle();
  if (error || !b) return fail(root, "Booking not found.");
  if (b.booking_status !== "pending") {
    root.innerHTML = `<div class="card stack"><h2>Booking ${esc(b.booking_status)}</h2>
      <p class="muted">${b.booking_status === "confirmed" ? "Your slot is locked in." : "This reservation is no longer active."}</p>
      <a class="btn" href="#/bookings">My bookings</a></div>`;
    return;
  }
  const expires = new Date(b.created_at).getTime() + RESERVATION_MINUTES * 60000;
  root.innerHTML = `
    <div class="card stack" style="max-width:520px;margin:0 auto">
      <h2>Confirm &amp; pay</h2>
      <div>
        <div class="stat"><span>Tournament</span><b>${esc(b.tournaments.name)}</b></div>
        <div class="stat"><span>Mode</span><b>${esc(b.tournaments.mode)}</b></div>
        <div class="stat"><span>Slot</span><b>#${esc(b.slots.slot_number)}</b></div>
        <div class="stat"><span>Amount</span><b>${inr(b.entry_fee)}</b></div>
      </div>
      <div class="center"><div class="muted small">Slot held for</div><div class="countdown" id="cd">--:--</div></div>
      <div id="msg"></div>
      <button class="btn block" id="pay">Pay ${inr(b.entry_fee)} with Paytm</button>
      <button class="btn ghost block" id="cancel">Release slot</button>
    </div>`;

  const cd = $("#cd", root);
  const tick = setInterval(() => {
    const left = Math.max(0, expires - Date.now());
    cd.textContent = `${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
    if (left === 0) { clearInterval(tick); $("#pay", root).disabled = true; $("#msg", root).innerHTML = banner("Reservation expired. Please pick a slot again.", "error"); }
  }, 500);

  $("#pay", root).onclick = (e) => busy(e.currentTarget, async () => {
    try {
      const res = await callFn("create-payment-order", { booking_id: bookingId });
      const form = document.createElement("form");
      form.method = "POST"; form.action = res.action_url;
      for (const [k, v] of Object.entries(res.fields)) {
        const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; form.appendChild(i);
      }
      document.body.appendChild(form);
      form.submit(); // redirect to Paytm checkout
    } catch (err) { $("#msg", root).innerHTML = banner(err.message, "error"); }
  });
  $("#cancel", root).onclick = () => {
    toast("Your reservation will be released automatically when the timer ends.");
    location.hash = "#/";
  };
  return () => clearInterval(tick);
}

/* ------------------------------------------------------------------ Payment result */
export async function viewPaymentResult(root, ctx, _p, query) {
  const order = query.get("order");
  loading(root);
  let status = query.get("status");
  // never trust the URL: re-verify with the server (which asks Paytm directly)
  if (order) {
    try { status = (await callFn("verify-payment", { order_id: order })).status; } catch (e) { status = "error:" + e.message; }
  }
  const map = {
    confirmed: ["ok", "Payment successful", "Your slot is confirmed. Room details appear in My Bookings once the admin publishes them."],
    already_confirmed: ["ok", "Payment successful", "Your slot is confirmed. Room details appear in My Bookings once the admin publishes them."],
    pending: ["warn", "Payment pending", "Paytm hasn't confirmed this payment yet. It may take a minute."],
    failed: ["error", "Payment failed", "No money was booked for this attempt. If you were charged, it is refunded by your bank/Paytm."],
    needs_refund: ["error", "Slot no longer available", "Your payment arrived after the reservation expired and the slot was taken. An admin will refund you."],
    amount_mismatch: ["error", "Payment amount mismatch", "The paid amount did not match the entry fee. Contact support."],
    unverified: ["error", "Could not verify payment", "We couldn't verify this payment with Paytm. Check My Bookings or try again."],
  };
  const [type, title, text] = map[status] ?? ["error", "Something went wrong", String(status ?? "").replace("error:", "")];
  root.innerHTML = `<div class="card stack" style="max-width:520px;margin:0 auto">
    <div class="banner ${type}"><b>${esc(title)}</b></div><p class="muted">${esc(text)}</p>
    <div class="row">
      ${status === "pending" ? '<button class="btn" id="re">Check again</button>' : ""}
      <a class="btn" href="#/bookings">My bookings</a><a class="btn ghost" href="#/">Tournaments</a></div></div>`;
  const re = $("#re", root); if (re) re.onclick = () => viewPaymentResult(root, ctx, _p, query);
}

/* ------------------------------------------------------------------ My bookings */
export async function viewBookings(root) {
  loading(root);
  const { data, error } = await sb.from("bookings")
    .select("*, tournaments(id, name, mode, match_time, status), slots(slot_number)")
    .order("created_at", { ascending: false });
  if (error) return fail(root, "Could not load bookings: " + error.message);

  root.innerHTML = `<div class="page-head"><h1>My bookings</h1></div>` + (data.length
    ? `<div class="grid">${data.map((b) => `
      <article class="card stack">
        <div class="row between">${badge(b.tournaments.mode, "mode")}${badge(b.booking_status)}</div>
        <h3>${esc(b.tournaments.name)}</h3>
        <div>
          <div class="stat"><span>Slot</span><b>#${esc(b.slots.slot_number)}</b></div>
          <div class="stat"><span>Entry fee</span><b>${inr(b.entry_fee)}</b></div>
          <div class="stat"><span>Payment</span>${badge(b.payment_status)}</div>
          <div class="stat"><span>Match time</span><b>${esc(fmtDate(b.tournaments.match_time))}</b></div>
          <div class="stat"><span>Booked</span><b>${esc(fmtDate(b.created_at))}</b></div>
        </div>
        ${b.booking_status === "pending" ? `<a class="btn block" href="#/pay/${b.id}">Complete payment</a>` : ""}
        ${["confirmed", "completed"].includes(b.booking_status) ? `<a class="btn block" href="#/room/${b.tournaments.id}">Room ID &amp; password</a>` : ""}
        ${b.booking_status === "cancelled" && b.payment_status === "successful"
          ? '<div class="banner warn small">Your payment is being refunded by the admin.</div>' : ""}
      </article>`).join("")}</div>`
    : '<div class="empty card">No bookings yet. <a href="#/">Browse tournaments</a></div>');
}

/* ------------------------------------------------------------------ Room credentials */
export async function viewRoom(root, ctx, [tid]) {
  loading(root);
  const [{ data: t }, { data: room, error }] = await Promise.all([
    sb.from("tournaments").select("name, match_time").eq("id", tid).maybeSingle(),
    sb.from("room_credentials").select("room_id, room_password, updated_at").eq("tournament_id", tid).maybeSingle(),
  ]);
  if (error) return fail(root, "Could not load room details: " + error.message);
  root.innerHTML = `<a class="small" href="#/bookings">← My bookings</a>
    <div class="card stack" style="max-width:520px;margin:12px auto">
      <h2>${esc(t?.name ?? "Match")} room</h2>
      ${room ? `
        <div><label>Room ID</label><div class="cred"><span>${esc(room.room_id)}</span><button class="btn ghost sm" data-copy="${esc(room.room_id)}">Copy</button></div></div>
        <div><label>Password</label><div class="cred"><span>${esc(room.room_password)}</span><button class="btn ghost sm" data-copy="${esc(room.room_password)}">Copy</button></div></div>
        <p class="muted small">Do not share these. Join before ${esc(fmtDate(t?.match_time))}.</p>`
        : banner("Room details haven't been published yet, or you don't have a confirmed booking for this match. Check again closer to match time.", "warn")}
    </div>`;
  $$("[data-copy]", root).forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch { toast("Copy failed", "error"); }
  }));
}

/* ------------------------------------------------------------------ Results */
export async function viewResults(root) {
  loading(root);
  const { data, error } = await sb.from("match_results")
    .select("*, bookings(slots(slot_number), tournaments(name, mode))").order("created_at", { ascending: false });
  if (error) return fail(root, "Could not load results: " + error.message);
  const total = data.filter((r) => r.verified).reduce((s, r) => s + Number(r.reward_amount), 0);
  root.innerHTML = `<div class="page-head"><h1>Match results</h1><p>Rewards are paid only after the admin verifies your kills.</p></div>
    ${data.length ? `<div class="card stack"><div class="row between"><span class="muted">Verified rewards</span><b style="font-size:1.4rem">${inr(total)}</b></div>
    <div class="table-wrap"><table><thead><tr><th>Tournament</th><th>Slot</th><th>Kills</th><th>Winner</th><th>Reward</th><th>Status</th></tr></thead><tbody>
    ${data.map((r) => `<tr><td>${esc(r.bookings.tournaments.name)}</td><td>#${esc(r.bookings.slots.slot_number)}</td><td>${r.kills}</td>
      <td>${r.winner ? "🏆" : "—"}</td><td>${inr(r.reward_amount)}</td><td>${badge(r.verified ? "verified" : "pending", r.verified ? "successful" : "pending")}</td></tr>`).join("")}
    </tbody></table></div></div>` : '<div class="empty card">No results yet. They appear after your matches are verified.</div>'}`;
}
