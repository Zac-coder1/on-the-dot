-- On the Dot — database setup
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste ALL of this → Run.
-- This makes one table to hold each player's stats, and locks it so a player can
-- only ever read or change THEIR OWN row.

create table if not exists public.stats (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  data      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security = the lock. Turn it on for this table.
alter table public.stats enable row level security;

-- Clear old versions of these rules if you run this file more than once.
drop policy if exists "read own stats"   on public.stats;
drop policy if exists "insert own stats" on public.stats;
drop policy if exists "update own stats" on public.stats;

-- A logged-in user may READ only their own row.
create policy "read own stats"
  on public.stats for select
  using (auth.uid() = user_id);

-- A logged-in user may CREATE only their own row.
create policy "insert own stats"
  on public.stats for insert
  with check (auth.uid() = user_id);

-- A logged-in user may UPDATE only their own row.
create policy "update own stats"
  on public.stats for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
