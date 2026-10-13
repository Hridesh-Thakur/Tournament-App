// Paytm POSTs the browser here after checkout. verify_jwt is OFF for this function
// (see supabase/config.toml) because Paytm cannot send a Supabase JWT. Trust comes from:
//   1) the CHECKSUMHASH signature, and
//   2) a server-to-server Transaction Status call to Paytm (done in verifyAndConfirm).
import { serviceClient } from "../_shared/common.ts";
import { verifySignature, verifyAndConfirm } from "../_shared/paytm.ts";

Deno.serve(async (req) => {
  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const back = (order: string, status: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `${site}/index.html#/payment-result?order=${encodeURIComponent(order)}&status=${status}` },
    });

  let orderId = "";
  try {
    const form = await req.formData();
    const params: Record<string, string> = {};
    form.forEach((v, k) => { params[k] = String(v); });
    orderId = params.ORDERID ?? "";
    const checksum = params.CHECKSUMHASH;
    delete params.CHECKSUMHASH;

    if (!orderId || !checksum || !(await verifySignature(params, checksum))) {
      console.error("Callback checksum invalid for", orderId);
      return back(orderId, "unverified");
    }
    const { data: exists } = await serviceClient().from("payments")
      .select("id").eq("provider_order_id", orderId).maybeSingle();
    if (!exists) return back(orderId, "unverified");

    const result = await verifyAndConfirm(orderId);
    return back(orderId, result.status);
  } catch (e) {
    console.error("Callback error", e);
    return back(orderId, "error");
  }
});
