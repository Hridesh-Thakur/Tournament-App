-- 0002_functions.sql : trusted database functions

-- ---------- helpers ----------
create or replace function public.is_admin(p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_roles where user_id = p_uid);
$$;

create or replace function public.is_confirmed_participant(p_tournament uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.bookings
    where tournament_id = p_tournament and user_id = p_uid
      and booking_status in ('confirmed', 'completed')
      and payment_status = 'successful'
  );
$$;

-- ---------- profile creation on signup ----------
-- The client passes game_name / phone_number / policy_accepted as signUp metadata.
-- Only those keys are read. Roles are NEVER read from metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_game text := trim(coalesce(new.raw_user_meta_data->>'game_name', ''));
  v_phone text := trim(coalesce(new.raw_user_meta_data->>'phone_number', ''));
  v_policy boolean := coalesce((new.raw_user_meta_data->>'policy_accepted')::boolean, false);
begin
  if char_length(v_game) < 2 or char_length(v_game) > 30 then
    raise exception 'Invalid game name';
  end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'Invalid mobile number';
  end if;
  if not v_policy then
    raise exception 'Policy must be accepted';
  end if;
  insert into public.profiles (id, game_name, email, phone_number, policy_accepted, policy_accepted_at)
  values (new.id, v_game, new.email, v_phone, true, now());
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep profile email in sync if the auth email changes
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- ---------- release expired reservations ----------
create or replace function public.release_expired_reservations()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with expired as (
    select id from public.slots
    where status = 'reserved' and reserved_until is not null and reserved_until < now()
    for update skip locked
  ), b as (
    update public.bookings
       set booking_status = 'cancelled', payment_status = 'failed'
     where slot_id in (select id from expired) and booking_status = 'pending'
    returning id
  ), p as (
    update public.payments set payment_status = 'failed'
     where booking_id in (select id from b) and payment_status = 'pending'
    returning id
  )
  update public.slots
     set status = 'available', reserved_until = null, reserved_by = null
   where id in (select id from expired);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------- atomic slot reservation (called by logged-in users) ----------
create or replace function public.reserve_slot(p_slot_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_slot public.slots%rowtype;
  v_t public.tournaments%rowtype;
  v_booking uuid;
begin
  if v_uid is null then raise exception 'Please log in first'; end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then
    raise exception 'Please verify your email before booking';
  end if;

  perform public.release_expired_reservations();

  select * into v_slot from public.slots where id = p_slot_id for update;
  if not found then raise exception 'Slot not found'; end if;

  select * into v_t from public.tournaments where id = v_slot.tournament_id for share;
  if v_t.status <> 'open' then raise exception 'Tournament is not open for booking'; end if;
  if v_t.match_time is not null and v_t.match_time <= now() then
    raise exception 'Booking closed: match has started';
  end if;
  if v_slot.status <> 'available' then raise exception 'Slot is no longer available'; end if;

  if exists (
    select 1 from public.bookings
    where user_id = v_uid and tournament_id = v_t.id
      and booking_status in ('pending', 'confirmed', 'completed')
  ) then
    raise exception 'You already have a booking in this tournament';
  end if;

  insert into public.bookings (user_id, tournament_id, slot_id, entry_fee)
  values (v_uid, v_t.id, v_slot.id, v_t.entry_fee)
  returning id into v_booking;

  update public.slots
     set status = 'reserved', reserved_by = v_uid, reserved_until = now() + interval '10 minutes'
   where id = v_slot.id;

  return v_booking;
end $$;

-- ---------- payment confirmation (service role only) ----------
create or replace function public.confirm_booking_payment(p_order_id text, p_txn_id text, p_amount numeric)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments%rowtype;
  v_b public.bookings%rowtype;
  v_slot public.slots%rowtype;
begin
  select * into v_pay from public.payments where provider_order_id = p_order_id for update;
  if not found then raise exception 'Unknown order'; end if;
  if v_pay.payment_status = 'successful' then return 'already_confirmed'; end if;
  if v_pay.payment_status = 'refunded' then return 'already_refunded'; end if;

  if p_amount <> v_pay.amount then
    update public.payments set payment_status = 'failed' where id = v_pay.id;
    return 'amount_mismatch';
  end if;

  select * into v_b from public.bookings where id = v_pay.booking_id for update;
  select * into v_slot from public.slots where id = v_b.slot_id for update;

  if v_b.booking_status = 'pending' then
    null; -- reservation still held
  elsif v_b.booking_status = 'cancelled' and v_slot.status = 'available'
        and not exists (select 1 from public.bookings
                        where user_id = v_b.user_id and tournament_id = v_b.tournament_id
                          and booking_status in ('pending','confirmed','completed')) then
    null; -- reservation lapsed but nobody else took the slot: revive it
  else
    -- money received but slot is gone: record payment so an admin can refund it
    update public.payments set payment_status = 'successful', provider_transaction_id = p_txn_id
     where id = v_pay.id;
    return 'needs_refund';
  end if;

  update public.payments set payment_status = 'successful', provider_transaction_id = p_txn_id
   where id = v_pay.id;
  update public.bookings set booking_status = 'confirmed', payment_status = 'successful'
   where id = v_b.id;
  update public.slots set status = 'booked', reserved_until = null, reserved_by = v_b.user_id
   where id = v_slot.id;
  update public.tournaments t set status = 'full'
   where t.id = v_b.tournament_id and t.status = 'open'
     and not exists (select 1 from public.slots s where s.tournament_id = t.id and s.status <> 'booked');
  return 'confirmed';
end $$;

create or replace function public.mark_payment_failed(p_order_id text, p_txn_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.payments
     set payment_status = 'failed', provider_transaction_id = coalesce(p_txn_id, provider_transaction_id)
   where provider_order_id = p_order_id and payment_status = 'pending';
end $$;

-- ---------- admin operations (service role only; edge function checks admin_roles) ----------
create or replace function public.admin_create_tournament(
  p_name text, p_mode tournament_mode, p_match_time timestamptz, p_status tournament_status default 'open')
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.tournament_defaults%rowtype; v_id uuid;
begin
  select * into d from public.tournament_defaults where mode = p_mode;
  insert into public.tournaments (name, mode, entry_fee, max_players, winner_prize, kill_reward, status, match_time)
  values (p_name, p_mode, d.entry_fee, d.max_players, d.winner_prize, d.kill_reward, p_status, p_match_time)
  returning id into v_id;
  insert into public.slots (tournament_id, slot_number)
  select v_id, g from generate_series(1, d.max_players) g;
  return v_id;
end $$;

create or replace function public.admin_set_tournament_status(p_tournament uuid, p_status tournament_status)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.tournaments set status = p_status where id = p_tournament;
  if p_status = 'completed' then
    update public.bookings set booking_status = 'completed'
     where tournament_id = p_tournament and booking_status = 'confirmed';
  elsif p_status = 'cancelled' then
    -- confirmed paid bookings are cancelled; payments stay 'successful' until an admin refunds them
    update public.bookings set booking_status = 'cancelled'
     where tournament_id = p_tournament and booking_status in ('pending', 'confirmed');
    update public.slots set status = 'available', reserved_until = null, reserved_by = null
     where tournament_id = p_tournament and status = 'reserved';
    update public.room_credentials set published = false, updated_at = now() where tournament_id = p_tournament;
  end if;
end $$;

create or replace function public.admin_set_room_credentials(
  p_tournament uuid, p_room_id text, p_room_password text, p_published boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.room_credentials (tournament_id, room_id, room_password, published, updated_at)
  values (p_tournament, p_room_id, p_room_password, p_published, now())
  on conflict (tournament_id) do update
    set room_id = excluded.room_id, room_password = excluded.room_password,
        published = excluded.published, updated_at = now();
end $$;

-- Reward calculation: Full Map = verified kills x kill_reward; Lone Wolf / CS = winner prize.
create or replace function public.approve_match_result(
  p_booking uuid, p_kills integer, p_winner boolean, p_verified boolean)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_t public.tournaments%rowtype; v_reward numeric := 0;
begin
  select t.* into v_t from public.tournaments t
    join public.bookings b on b.tournament_id = t.id
   where b.id = p_booking and b.booking_status in ('confirmed', 'completed') and b.payment_status = 'successful';
  if not found then raise exception 'Booking is not a confirmed participant'; end if;
  if p_kills < 0 then raise exception 'Invalid kills'; end if;

  if p_verified then
    if v_t.mode = 'Full Map' then
      v_reward := p_kills * coalesce(v_t.kill_reward, 0);
    elsif p_winner then
      v_reward := v_t.winner_prize;
    end if;
  end if;

  insert into public.match_results (booking_id, kills, verified, reward_amount, winner)
  values (p_booking, p_kills, p_verified, v_reward, p_winner)
  on conflict (booking_id) do update
    set kills = excluded.kills, verified = excluded.verified,
        reward_amount = excluded.reward_amount, winner = excluded.winner;
  return v_reward;
end $$;

create or replace function public.admin_mark_payment_refunded(p_payment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.payments set payment_status = 'refunded' where id = p_payment and payment_status = 'successful';
  update public.bookings set payment_status = 'refunded'
   where id = (select booking_id from public.payments where id = p_payment);
end $$;

-- ---------- execute privileges ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.is_confirmed_participant(uuid, uuid) to authenticated;
grant execute on function public.reserve_slot(uuid) to authenticated;
-- service role only:
grant execute on function public.release_expired_reservations() to service_role;
grant execute on function public.confirm_booking_payment(text, text, numeric) to service_role;
grant execute on function public.mark_payment_failed(text, text) to service_role;
grant execute on function public.admin_create_tournament(text, tournament_mode, timestamptz, tournament_status) to service_role;
grant execute on function public.admin_set_tournament_status(uuid, tournament_status) to service_role;
grant execute on function public.admin_set_room_credentials(uuid, text, text, boolean) to service_role;
grant execute on function public.approve_match_result(uuid, integer, boolean, boolean) to service_role;
grant execute on function public.admin_mark_payment_refunded(uuid) to service_role;
