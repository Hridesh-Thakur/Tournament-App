// Releases reservations whose 10-minute hold has expired.
// Invoke on a schedule (see SETUP.md) with header:  x-cron-secret: <CRON_SECRET>
// (A pg_cron job calling the SQL function directly is also provided.)
import { handle, HttpError, json, serviceClient } from "../_shared/common.ts";

Deno.serve(handle(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Unauthorized");
  const { data, error } = await serviceClient().rpc("release_expired_reservations");
  if (error) throw new HttpError(500, error.message);
  return json({ released: data });
}));
