// Admin-only operations. Caller's JWT is verified against admin_roles, then the
// service role performs the write. Admins have no direct write access via RLS.
import { handle, HttpError, json, requireAdmin, serviceClient } from "../_shared/common.ts";

const MODES = ["Lone Wolf", "Full Map", "CS"];
const STATUSES = ["upcoming", "open", "full", "completed", "cancelled"];

Deno.serve(handle(async (req) => {
  await requireAdmin(req);
  const b = await req.json().catch(() => ({}));
  const sb = serviceClient();
  const fail = (msg: string) => { throw new HttpError(400, msg); };

  switch (b.action) {
    case "create_tournament": {
      const name = String(b.name ?? "").trim();
      if (name.length < 3 || name.length > 80) fail("Name must be 3-80 characters");
      if (!MODES.includes(b.mode)) fail("Invalid mode");
      const status = b.status ?? "open";
      if (!["upcoming", "open"].includes(status)) fail("Status must be upcoming or open");
      const when = b.match_time ? new Date(b.match_time) : null;
      if (when && isNaN(when.getTime())) fail("Invalid match time");
      const { data, error } = await sb.rpc("admin_create_tournament", {
        p_name: name, p_mode: b.mode, p_match_time: when?.toISOString() ?? null, p_status: status,
      });
      if (error) fail(error.message);
      return json({ tournament_id: data });
    }
    case "set_status": {
      if (!b.tournament_id) fail("tournament_id required");
      if (!STATUSES.includes(b.status)) fail("Invalid status");
      const { error } = await sb.rpc("admin_set_tournament_status", { p_tournament: b.tournament_id, p_status: b.status });
      if (error) fail(error.message);
      return json({ ok: true });
    }
    case "set_room": {
      if (!b.tournament_id) fail("tournament_id required");
      const roomId = String(b.room_id ?? "").trim();
      const pass = String(b.room_password ?? "").trim();
      if (!roomId || !pass) fail("Room ID and password are required");
      const { error } = await sb.rpc("admin_set_room_credentials", {
        p_tournament: b.tournament_id, p_room_id: roomId, p_room_password: pass, p_published: !!b.published,
      });
      if (error) fail(error.message);
      return json({ ok: true });
    }
    case "mark_refunded": {
      if (!b.payment_id) fail("payment_id required");
      const { error } = await sb.rpc("admin_mark_payment_refunded", { p_payment: b.payment_id });
      if (error) fail(error.message);
      return json({ ok: true });
    }
    case "release_expired": {
      const { data, error } = await sb.rpc("release_expired_reservations");
      if (error) fail(error.message);
      return json({ released: data });
    }
    default:
      fail("Unknown action");
  }
}));
