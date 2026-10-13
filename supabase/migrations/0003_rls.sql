-- 0003_rls.sql : Row Level Security
alter table public.profiles            enable row level security;
alter table public.admin_roles         enable row level security;
alter table public.tournaments         enable row level security;
alter table public.tournament_defaults enable row level security;
alter table public.slots               enable row level security;
alter table public.bookings            enable row level security;
alter table public.payments            enable row level security;
alter table public.room_credentials    enable row level security;
alter table public.match_results       enable row level security;

-- Defense in depth: strip default grants, then grant back only what is needed.
revoke all on public.profiles, public.admin_roles, public.tournaments, public.tournament_defaults,
              public.slots, public.bookings, public.payments, public.room_credentials,
              public.match_results from anon, authenticated;

-- profiles: read own row; update ONLY game_name and phone_number on own row.
grant select on public.profiles to authenticated;
grant update (game_name, phone_number) on public.profiles to authenticated;
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- No INSERT policy: profiles are created by the signup trigger only. No DELETE policy.

-- admin_roles: a user may read their own row (so the app knows to show the admin UI). No writes, ever.
grant select on public.admin_roles to authenticated;
create policy admin_roles_select_own on public.admin_roles for select to authenticated
  using (user_id = auth.uid());

-- tournaments: visible unless cancelled (or you hold a booking in it). Writes via service role only.
grant select on public.tournaments to authenticated;
create policy tournaments_select on public.tournaments for select to authenticated
  using (
    status in ('upcoming', 'open', 'full', 'completed')
    or public.is_admin()
    or exists (select 1 from public.bookings b where b.tournament_id = tournaments.id and b.user_id = auth.uid())
  );

-- tournament_defaults: read-only reference data
grant select on public.tournament_defaults to authenticated;
create policy defaults_select on public.tournament_defaults for select to authenticated using (true);

-- slots: availability only. reserved_by / reserved_until are hidden by column grants.
grant select (id, tournament_id, slot_number, status, created_at) on public.slots to authenticated;
create policy slots_select on public.slots for select to authenticated
  using (
    exists (select 1 from public.tournaments t
            where t.id = slots.tournament_id and t.status in ('open', 'full', 'completed', 'upcoming'))
    or public.is_admin()
  );

-- bookings: read own (admins read all). No client writes: slots are reserved via reserve_slot().
grant select on public.bookings to authenticated;
create policy bookings_select_own on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- payments: read own (admins read all). Only server-side verification writes.
grant select on public.payments to authenticated;
create policy payments_select_own on public.payments for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- room_credentials: only confirmed participants, only after publish. Admin can read all.
grant select on public.room_credentials to authenticated;
create policy room_select_participants on public.room_credentials for select to authenticated
  using (
    public.is_admin()
    or (published = true and public.is_confirmed_participant(tournament_id))
  );

-- match_results: users read results of their own bookings; admins read all.
grant select on public.match_results to authenticated;
create policy results_select_own on public.match_results for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.bookings b where b.id = match_results.booking_id and b.user_id = auth.uid())
  );

-- Admins have SELECT-only through RLS. Every admin WRITE goes through the `admin-action`
-- Edge Function, which verifies the caller's JWT against admin_roles and then uses the
-- service role. The service role bypasses RLS.

-- Make Realtime updates for slots possible (optional)
do $$ begin
  alter publication supabase_realtime add table public.slots;
exception when others then null; end $$;
