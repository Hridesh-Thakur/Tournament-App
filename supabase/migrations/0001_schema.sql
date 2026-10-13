-- 0001_schema.sql : tables, constraints, indexes, seed defaults
create extension if not exists "pgcrypto";

-- ---------- enums ----------
do $$ begin
  create type tournament_mode as enum ('Lone Wolf', 'Full Map', 'CS');
  create type tournament_status as enum ('upcoming', 'open', 'full', 'completed', 'cancelled');
  create type slot_status as enum ('available', 'reserved', 'booked');
  create type booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed');
  create type payment_status as enum ('pending', 'successful', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  game_name text not null check (char_length(game_name) between 2 and 30),
  email text not null,
  phone_number text not null check (phone_number ~ '^[6-9][0-9]{9}$'),
  policy_accepted boolean not null default false,
  policy_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint policy_required check (policy_accepted = true and policy_accepted_at is not null)
);

-- ---------- admin_roles ----------
create table if not exists public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'super_admin')),
  created_at timestamptz not null default now()
);

-- ---------- tournaments ----------
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode tournament_mode not null,
  entry_fee numeric(10,2) not null check (entry_fee >= 0),
  max_players integer not null check (max_players > 0),
  winner_prize numeric(10,2) not null default 0 check (winner_prize >= 0),
  kill_reward numeric(10,2) check (kill_reward is null or kill_reward >= 0),
  status tournament_status not null default 'upcoming',
  match_time timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tournaments_status_idx on public.tournaments(status, match_time);

-- Defaults per mode (used by admin create function)
create table if not exists public.tournament_defaults (
  mode tournament_mode primary key,
  entry_fee numeric(10,2) not null,
  max_players integer not null,
  winner_prize numeric(10,2) not null,
  kill_reward numeric(10,2)
);
insert into public.tournament_defaults(mode, entry_fee, max_players, winner_prize, kill_reward) values
  ('Lone Wolf', 30, 2, 50, null),
  ('Full Map', 40, 50, 0, 32),
  ('CS', 30, 8, 50, null)
on conflict (mode) do nothing;

-- ---------- slots ----------
create table if not exists public.slots (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  slot_number integer not null check (slot_number > 0),
  status slot_status not null default 'available',
  reserved_until timestamptz,
  reserved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint slots_tournament_slot_unique unique (tournament_id, slot_number)
);
create index if not exists slots_tournament_idx on public.slots(tournament_id, status);

-- ---------- bookings ----------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  slot_id uuid not null references public.slots(id) on delete cascade,
  booking_status booking_status not null default 'pending',
  payment_status payment_status not null default 'pending',
  entry_fee numeric(10,2) not null check (entry_fee >= 0),
  created_at timestamptz not null default now()
);
-- One active (pending/confirmed/completed) booking per slot
create unique index if not exists bookings_one_active_per_slot
  on public.bookings(slot_id) where booking_status in ('pending', 'confirmed', 'completed');
-- One active booking per user per tournament
create unique index if not exists bookings_one_active_per_user_tournament
  on public.bookings(user_id, tournament_id) where booking_status in ('pending', 'confirmed', 'completed');
create index if not exists bookings_user_idx on public.bookings(user_id, created_at desc);

-- ---------- payments ----------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount >= 0),
  provider text not null default 'paytm',
  provider_order_id text unique,
  provider_transaction_id text,
  payment_status payment_status not null default 'pending',
  created_at timestamptz not null default now()
);
create index if not exists payments_booking_idx on public.payments(booking_id);
create unique index if not exists payments_provider_txn_unique
  on public.payments(provider, provider_transaction_id) where provider_transaction_id is not null;

-- ---------- room_credentials ----------
create table if not exists public.room_credentials (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null unique references public.tournaments(id) on delete cascade,
  room_id text not null,
  room_password text not null,
  published boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------- match_results ----------
create table if not exists public.match_results (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  kills integer not null default 0 check (kills >= 0),
  verified boolean not null default false,
  reward_amount numeric(10,2) not null default 0 check (reward_amount >= 0),
  winner boolean not null default false,
  created_at timestamptz not null default now()
);
