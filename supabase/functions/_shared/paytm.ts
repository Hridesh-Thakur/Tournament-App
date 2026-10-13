// Paytm checksum + API helpers (server-side only; merchant key never leaves the function).
import { serviceClient } from "./common.ts";

const IV = new TextEncoder().encode("@@@@&&&&####$$$$");
const enc = new TextEncoder();

const MID = () => Deno.env.get("PAYTM_MID")!;
const KEY = () => Deno.env.get("PAYTM_MERCHANT_KEY")!;
export const WEBSITE = () => Deno.env.get("PAYTM_WEBSITE") ?? "WEBSTAGING";
export const HOST = () =>
  (Deno.env.get("PAYTM_ENV") ?? "staging") === "production"
    ? "https://securegw.paytm.in"
    : "https://securegw-stage.paytm.in";
export { MID };

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function aesKey(usage: "encrypt" | "decrypt") {
  return crypto.subtle.importKey("raw", enc.encode(KEY()), { name: "AES-CBC" }, false, [usage]);
}

function randomSalt(len = 4): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const r = crypto.getRandomValues(new Uint8Array(len));
  return [...r].map((n) => chars[n % chars.length]).join("");
}

export function paramsToString(params: Record<string, unknown>): string {
  return Object.keys(params).sort().map((k) => {
    const v = params[k];
    return v === null || v === undefined || String(v).toLowerCase() === "null" ? "" : String(v);
  }).join("|");
}

export async function generateSignature(payload: string | Record<string, unknown>): Promise<string> {
  const str = typeof payload === "string" ? payload : paramsToString(payload);
  const salt = randomSalt();
  const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(`${str}|${salt}`)));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: IV }, await aesKey("encrypt"), enc.encode(digest + salt),
  );
  return b64(cipher);
}

export async function verifySignature(payload: string | Record<string, unknown>, checksum: string): Promise<boolean> {
  try {
    const str = typeof payload === "string" ? payload : paramsToString(payload);
    const plain = new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, await aesKey("decrypt"), unb64(checksum)),
    );
    const salt = plain.slice(-4);
    const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(`${str}|${salt}`)));
    return plain === digest + salt;
  } catch {
    return false;
  }
}

async function paytmPost(path: string, body: Record<string, unknown>) {
  const signature = await generateSignature(JSON.stringify(body));
  const res = await fetch(`${HOST()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, head: { signature } }),
  });
  return await res.json();
}

export async function initiateTransaction(orderId: string, amount: number, custId: string, callbackUrl: string) {
  const body = {
    requestType: "Payment",
    mid: MID(),
    websiteName: WEBSITE(),
    orderId,
    callbackUrl,
    txnAmount: { value: amount.toFixed(2), currency: "INR" },
    userInfo: { custId },
  };
  return await paytmPost(`/theia/api/v1/initiateTransaction?mid=${MID()}&orderId=${orderId}`, body);
}

export async function fetchTransactionStatus(orderId: string) {
  return await paytmPost("/v3/order/status", { mid: MID(), orderId });
}

/**
 * Asks Paytm directly (never trusts the browser) for the order's status,
 * then updates the database through the service-role-only SQL functions.
 */
export async function verifyAndConfirm(orderId: string): Promise<{ status: string; detail?: string }> {
  const sb = serviceClient();
  const resp = await fetchTransactionStatus(orderId);
  const body = resp?.body ?? {};
  const sig = resp?.head?.signature;
  if (!sig || !(await verifySignature(JSON.stringify(body), sig))) {
    return { status: "unverified", detail: "Paytm response signature mismatch" };
  }
  if (body.orderId && body.orderId !== orderId) return { status: "unverified", detail: "Order mismatch" };

  const result = body?.resultInfo?.resultStatus;
  if (result === "TXN_SUCCESS") {
    const { data, error } = await sb.rpc("confirm_booking_payment", {
      p_order_id: orderId,
      p_txn_id: String(body.txnId ?? ""),
      p_amount: Number(body.txnAmount),
    });
    if (error) throw new Error(error.message);
    return { status: data as string };
  }
  if (result === "TXN_FAILURE") {
    await sb.rpc("mark_payment_failed", { p_order_id: orderId, p_txn_id: String(body.txnId ?? "") || null });
    return { status: "failed", detail: body?.resultInfo?.resultMsg };
  }
  return { status: "pending", detail: body?.resultInfo?.resultMsg };
}
