# Free Fire Tournament App: Supabase Setup

```
ff-tournament/
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/0001_schema.sql · 0002_functions.sql · 0003_rls.sql · 0004_cron.sql
│  └─ functions/  create-payment-order · paytm-callback · verify-payment
│                 release-expired-slots · approve-results · admin-action · _shared
├─ web/           index.html · css/ · js/ (vanilla ES modules, no build step)
├─ .env.example
└─ SETUP.md
```

## 1. Create the Supabase project
1. supabase.com → New project. Save the DB password.
2. Project Settings → API: copy **Project URL** and the **anon / publishable key**.
3. Install the CLI (`npm i -g supabase`), then in this folder:
   `supabase login` → `supabase link --project-ref YOUR-PROJECT-REF`

## 2. Run the migrations
```
supabase db push
```
Or paste 0001 → 0002 → 0003 → 0004 into Dashboard → SQL Editor in order.
(0004 needs the `pg_cron` extension: Database → Extensions. If unavailable, schedule the
`release-expired-slots` function instead, see step 5.)

## 3. Configure Authentication
Dashboard → Authentication:
- **Providers → Email**: enabled, **Confirm email = ON** (this is what blocks unverified users; the DB also refuses bookings for unverified emails).
- **URL Configuration**: Site URL = your hosted site URL; add `https://your-site/index.html` to **Redirect URLs** (also `http://localhost:5500/index.html` for local testing).
- Password minimum length 8. For real email volume, set up custom SMTP (the built-in sender is heavily rate-limited).
- Optionally customise the confirmation and reset email templates.

## 4. Frontend config
Edit `web/js/config.js` with your Project URL and anon key. Only the anon key goes there.
Host `web/` on any static host (Vercel, Netlify, Cloudflare Pages) or run locally: `npx serve web`.
Set `PRIVACY_POLICY_URL` when you have it.

## 5. Deploy Edge Functions
```
cp .env.example .env.secrets     # keep only the "Edge Function secrets" lines, fill real values
supabase secrets set --env-file ./.env.secrets
supabase functions deploy create-payment-order
supabase functions deploy paytm-callback
supabase functions deploy verify-payment
supabase functions deploy release-expired-slots
supabase functions deploy approve-results
supabase functions deploy admin-action
```
`.env.secrets` must never be committed. Your Paytm callback URL is
`https://YOUR-PROJECT-REF.supabase.co/functions/v1/paytm-callback`. It is sent per transaction, but
whitelist it in the Paytm dashboard if required.
Optional scheduler for the Edge Function (if not using pg_cron): call it every minute with
`curl -X POST -H "x-cron-secret: $CRON_SECRET" https://YOUR-PROJECT-REF.supabase.co/functions/v1/release-expired-slots`.

**Paytm:** start with staging (`PAYTM_ENV=staging`, `PAYTM_WEBSITE=WEBSTAGING`, test MID/key from the Paytm developer dashboard). Go live by switching to the production MID, key, `WEBPROD`, `PAYTM_ENV=production`.

## 6. Create the first admin (securely)
There is no way to become admin from the app. Admins are rows in `admin_roles`, writable only with
the service role / SQL editor.
1. Register normally in the app and verify the email.
2. Dashboard → SQL Editor:
```sql
insert into public.admin_roles (user_id, role)
select id, 'super_admin' from auth.users where email = 'you@example.com';
```
3. Log out and in again; an **Admin** tab appears.

## 7. How the security works
- Passwords live only in Supabase Auth. `profiles` is created by a DB trigger at signup and holds no password.
- RLS is on for every table. Users can only SELECT their own bookings/payments/results; they have **no** INSERT/UPDATE on bookings, payments, results, tournaments, roles. On `profiles` they can only edit `game_name` and `phone_number` (column grants), so they can't change their id, email or policy fields.
- Slots are reserved only via `reserve_slot()`: one transaction with row locks, checks verified email, open tournament, availability and one-booking-per-tournament. Partial unique indexes enforce no double booking even under races.
- Payments are marked successful only by `confirm_booking_payment()`, executable by the service role only, and called only after the Edge Function has (a) verified Paytm's checksum and (b) fetched the transaction status directly from Paytm, with the amount compared to the DB amount.
- Room credentials are readable via RLS only by confirmed, paid participants after `published = true`.
- Admin writes go through `admin-action` / `approve-results`, which check the JWT user against `admin_roles` first. Service-role key and Paytm secrets exist only in Edge Function environment.
- Reservations last 10 minutes; expired ones are released every minute.

## 8. Test checklist
**Registration / login**
- [ ] Register with invalid data (short IGN, bad phone, weak password, mismatched confirm, unchecked policy) → clear field errors.
- [ ] Valid registration → "check your email"; a row appears in `profiles` with matching UUID, phone, IGN, `policy_accepted_at`; no password column anywhere.
- [ ] Login before verifying → blocked with message. After verifying → login works; refresh page keeps session; logout works.
- [ ] Forgot password email → link → set new password → can log in.
- [ ] Logged out, open `#/bookings` or `#/tournament/...` → redirected to login.
- [ ] In browser console run `sb`-style update on your own `admin_roles` / insert a role → rejected (permission denied).

**Booking**
- [ ] Admin creates each mode; slot counts are 2 / 50 / 8 and fees/prizes match defaults.
- [ ] Select a slot → reserved → pay page with countdown. Other account sees the slot as reserved.
- [ ] **Duplicate prevention:** two accounts click the same slot at the same time → one succeeds, the other gets "Slot is no longer available". Same user can't hold two slots in one tournament.
- [ ] Let the timer expire → slot becomes available again within ~1 minute; booking shows cancelled.
- [ ] Unverified user calling `reserve_slot` is rejected (disable confirmation in a test project to try).

**Payment (Paytm staging)**
- [ ] Pay successfully → redirected back → "Payment successful"; booking confirmed, payment successful, slot booked.
- [ ] Cancel/fail at Paytm → booking stays pending, payment failed, can retry within the hold window.
- [ ] Tamper with the URL `?status=confirmed` for an unpaid order → app re-verifies and shows the real status.
- [ ] From the browser, try `update bookings set payment_status='successful'` → denied.
- [ ] Fill the last slot → tournament status flips to `full`.

**Room credentials / results**
- [ ] Admin saves room creds unpublished → participant sees "not published". Publish → participant sees them.
- [ ] A non-participant (or pending booking) cannot read the room row (`select` returns nothing).
- [ ] Full Map: enter 5 kills and Approve → reward ₹160. Lone Wolf/CS: mark winner → ₹50. Player sees it under Results.
- [ ] Cancel a tournament → bookings cancelled, paid ones appear under Refunds due; "Mark refunded" updates the payment.

## Notes and limits
- Paytm **refunds and prize payouts are not automated**; the app tracks and flags them for admins.
- Paytm's API shapes are implemented from their documented Initiate Transaction / Transaction Status flow; verify against staging before launch.
- If a payment lands after the hold expired and the slot was taken, it's recorded and shown under "Refunds due"; if the slot is still free, the booking is revived automatically.
