// Creates a payment row for a pending booking and initiates a Paytm transaction.
// Amount always comes from the database, never from the client.
import { handle, HttpError, json, requireUser, serviceClient } from "../_shared/common.ts";
import { HOST, initiateTransaction, MID } from "../_shared/paytm.ts";

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const { booking_id } = await req.json().catch(() => ({}));
  if (!booking_id) throw new HttpError(400, "booking_id is required");

  const sb = serviceClient();
  await sb.rpc("release_expired_reservations");

  const { data: booking } = await sb.from("bookings")
    .select("id, user_id, slot_id, entry_fee, booking_status, tournament_id")
    .eq("id", booking_id).eq("user_id", user.id).maybeSingle();
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.booking_status !== "pending") {
    throw new HttpError(409, "This reservation has expired or is already processed");
  }
  if (Number(booking.entry_fee) <= 0) throw new HttpError(400, "Invalid entry fee");

  const orderId = `FF${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
  const { error: insErr } = await sb.from("payments").insert({
    booking_id: booking.id,
    user_id: user.id,
    amount: booking.entry_fee,
    provider: "paytm",
    provider_order_id: orderId,
    payment_status: "pending",
  });
  if (insErr) throw new HttpError(500, "Could not create payment");

  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/paytm-callback`;
  const resp = await initiateTransaction(orderId, Number(booking.entry_fee), user.id, callbackUrl);
  const txnToken = resp?.body?.txnToken;
  if (!txnToken) {
    await sb.rpc("mark_payment_failed", { p_order_id: orderId, p_txn_id: null });
    console.error("Paytm initiate failed", JSON.stringify(resp?.body?.resultInfo));
    throw new HttpError(502, resp?.body?.resultInfo?.resultMsg ?? "Paytm could not start the payment");
  }

  return json({
    order_id: orderId,
    action_url: `${HOST()}/theia/api/v1/showPaymentPage?mid=${MID()}&orderId=${orderId}`,
    fields: { mid: MID(), orderId, txnToken },
  });
}));
