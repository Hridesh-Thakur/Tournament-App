// Admin-only: approve a participant's match result and calculate the reward.
//   Full Map  -> verified kills x kill_reward (₹32)
//   Lone Wolf / CS -> winner_prize if marked winner
import { handle, HttpError, json, requireAdmin, serviceClient } from "../_shared/common.ts";

Deno.serve(handle(async (req) => {
  await requireAdmin(req);
  const b = await req.json().catch(() => ({}));
  const kills = Number(b.kills ?? 0);
  if (!b.booking_id) throw new HttpError(400, "booking_id is required");
  if (!Number.isInteger(kills) || kills < 0 || kills > 100) throw new HttpError(400, "kills must be 0-100");

  const { data, error } = await serviceClient().rpc("approve_match_result", {
    p_booking: b.booking_id,
    p_kills: kills,
    p_winner: !!b.winner,
    p_verified: b.verified !== false,
  });
  if (error) throw new HttpError(400, error.message);
  return json({ reward_amount: data });
}));
