import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const CFG = window.APP_CONFIG;

export const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Call an Edge Function as the logged-in user; surfaces the server's error message. */
export async function callFn(name, body = {}) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const RESERVATION_MINUTES = 10;
