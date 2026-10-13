// Called by the app after redirect (and for "Refresh status") to re-check a payment
// directly with Paytm. Idempotent. The user can only check their own orders.
import { handle, HttpError, json, requireUser, serviceClient } from "../_shared/common.ts";
import { verifyAndConfirm } from "../_shared/paytm.ts";

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const { order_id } = await req.json().catch(() => ({}));
  if (!order_id) throw new HttpError(400, "order_id is required");

  const sb = serviceClient();
  const { data: pay } = await sb.from("payments")
    .select("id, user_id, payment_status").eq("provider_order_id", order_id).maybeSingle();
  if (!pay || pay.user_id !== user.id) throw new HttpError(404, "Order not found");

  if (pay.payment_status === "successful") return json({ status: "already_confirmed" });
  return json(await verifyAndConfirm(order_id));
}));
