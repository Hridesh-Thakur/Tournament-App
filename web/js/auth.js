import { sb, CFG } from "./supabase.js";
import { $, esc, busy, toast, setFieldError, banner } from "./ui.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizePhone(raw) {
  let p = String(raw || "").replace(/[\s-]/g, "");
  if (p.startsWith("+91")) p = p.slice(3);
  else if (p.startsWith("91") && p.length === 12) p = p.slice(2);
  else if (p.startsWith("0") && p.length === 11) p = p.slice(1);
  return p;
}

function friendlyAuthError(err) {
  const m = (err?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "Incorrect email or password.";
  if (m.includes("not confirmed")) return "Please verify your email first. Check your inbox (and spam) for the link.";
  if (m.includes("already registered") || m.includes("already been registered")) return "This email is already registered. Try logging in.";
  if (m.includes("database error saving new user")) return "Could not create your profile. Check your game name, mobile number and policy acceptance.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Please wait a few minutes and try again.";
  if (m.includes("password")) return err.message;
  return err?.message || "Something went wrong. Please try again.";
}

export function viewLogin(root) {
  root.innerHTML = `
  <section class="auth card stack">
    <div><h1>Login</h1><p class="muted">Enter the arena. Book your slot.</p></div>
    <div id="msg"></div>
    <form id="f" class="stack" novalidate>
      <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required><div class="err"></div></div>
      <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required><div class="err"></div></div>
      <button class="btn block" type="submit">Login</button>
    </form>
    <div class="row between small"><a href="#/forgot">Forgot password?</a><a href="#/register">Create account</a></div>
  </section>`;
  const f = $("#f", root);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#email", f), pw = $("#pw", f);
    const eOk = EMAIL_RE.test(email.value.trim());
    setFieldError(email, eOk ? "" : "Enter a valid email address");
    setFieldError(pw, pw.value ? "" : "Enter your password");
    if (!eOk || !pw.value) return;
    await busy($("button", f), async () => {
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      if (error) { $("#msg", root).innerHTML = banner(friendlyAuthError(error), "error"); return; }
      location.hash = "#/";
    });
  };
}

export function viewRegister(root) {
  root.innerHTML = `
  <section class="auth card stack">
    <div><h1>Register</h1><p class="muted">One account. Every tournament.</p></div>
    <div id="msg"></div>
    <form id="f" class="stack" novalidate>
      <div><label for="ign">Free Fire Game Name (IGN)</label><input id="ign" maxlength="30" autocomplete="nickname" required><div class="err"></div></div>
      <div><label for="email">Gmail / Email Address</label><input id="email" type="email" autocomplete="email" required><div class="err"></div></div>
      <div><label for="phone">Mobile Number</label><input id="phone" type="tel" inputmode="numeric" placeholder="10-digit number" autocomplete="tel" required><div class="err"></div></div>
      <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password" required><div class="err"></div></div>
      <div><label for="pw2">Confirm Password</label><input id="pw2" type="password" autocomplete="new-password" required><div class="err"></div></div>
      <div>
        <label class="check"><input id="policy" type="checkbox">
          <span>I accept the <a href="${esc(CFG.PRIVACY_POLICY_URL)}" target="_blank" rel="noopener">Privacy Policy</a> and Terms.</span></label>
        <div class="err"></div>
      </div>
      <button class="btn block" type="submit">Create account</button>
    </form>
    <div class="small">Already registered? <a href="#/login">Login</a></div>
  </section>`;
  const f = $("#f", root);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const ign = $("#ign", f), email = $("#email", f), phone = $("#phone", f);
    const pw = $("#pw", f), pw2 = $("#pw2", f), policy = $("#policy", f);
    const phoneVal = normalizePhone(phone.value);
    const checks = [
      [ign, ign.value.trim().length >= 2 && ign.value.trim().length <= 30, "Game name must be 2-30 characters"],
      [email, EMAIL_RE.test(email.value.trim()), "Enter a valid email address"],
      [phone, /^[6-9][0-9]{9}$/.test(phoneVal), "Enter a valid 10-digit Indian mobile number"],
      [pw, pw.value.length >= 8 && /[A-Za-z]/.test(pw.value) && /[0-9]/.test(pw.value), "At least 8 characters with a letter and a number"],
      [pw2, pw2.value === pw.value && pw2.value !== "", "Passwords do not match"],
      [policy, policy.checked, "You must accept the policy to register"],
    ];
    let ok = true;
    for (const [el, valid, msg] of checks) { setFieldError(el, valid ? "" : msg); if (!valid) ok = false; }
    if (!ok) return;

    await busy($("button", f), async () => {
      const { data, error } = await sb.auth.signUp({
        email: email.value.trim(),
        password: pw.value,
        options: {
          emailRedirectTo: `${CFG.SITE_URL}/index.html`,
          data: { game_name: ign.value.trim(), phone_number: phoneVal, policy_accepted: true },
        },
      });
      if (error) { $("#msg", root).innerHTML = banner(friendlyAuthError(error), "error"); return; }
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        $("#msg", root).innerHTML = banner("This email is already registered. Try logging in.", "error"); return;
      }
      if (data.session) { location.hash = "#/"; return; } // email confirmation disabled in project
      root.innerHTML = `<section class="auth card stack"><h1>Check your email</h1>
        <p class="muted">We sent a verification link to <b>${esc(email.value.trim())}</b>. Verify it, then log in. You can't book tournaments until your email is verified.</p>
        <a class="btn block" href="#/login">Go to login</a></section>`;
    });
  };
}

export function viewForgot(root) {
  root.innerHTML = `
  <section class="auth card stack">
    <div><h1>Reset password</h1><p class="muted">We'll email you a reset link.</p></div>
    <div id="msg"></div>
    <form id="f" class="stack" novalidate>
      <div><label for="email">Email</label><input id="email" type="email" autocomplete="email"><div class="err"></div></div>
      <button class="btn block" type="submit">Send reset link</button>
    </form>
    <a class="small" href="#/login">Back to login</a>
  </section>`;
  const f = $("#f", root);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#email", f);
    const ok = EMAIL_RE.test(email.value.trim());
    setFieldError(email, ok ? "" : "Enter a valid email address");
    if (!ok) return;
    await busy($("button", f), async () => {
      const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: `${CFG.SITE_URL}/index.html` });
      $("#msg", root).innerHTML = error ? banner(friendlyAuthError(error), "error")
        : banner("If that email is registered, a reset link is on its way.", "ok");
    });
  };
}

export function viewReset(root) {
  root.innerHTML = `
  <section class="auth card stack">
    <div><h1>New password</h1></div>
    <div id="msg"></div>
    <form id="f" class="stack" novalidate>
      <div><label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password"><div class="err"></div></div>
      <div><label for="pw2">Confirm new password</label><input id="pw2" type="password" autocomplete="new-password"><div class="err"></div></div>
      <button class="btn block" type="submit">Update password</button>
    </form>
  </section>`;
  const f = $("#f", root);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const pw = $("#pw", f), pw2 = $("#pw2", f);
    const a = pw.value.length >= 8 && /[A-Za-z]/.test(pw.value) && /[0-9]/.test(pw.value);
    const b = pw.value === pw2.value;
    setFieldError(pw, a ? "" : "At least 8 characters with a letter and a number");
    setFieldError(pw2, b ? "" : "Passwords do not match");
    if (!a || !b) return;
    await busy($("button", f), async () => {
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) { $("#msg", root).innerHTML = banner(friendlyAuthError(error), "error"); return; }
      toast("Password updated");
      location.hash = "#/";
    });
  };
}
