-- =============================================================
-- Dual-Stem Interactive Jukebox — Supabase schema
-- Run this in the Supabase SQL editor (or via `supabase db push`)
-- =============================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ----------------------------------------------------------
-- 1. Status enum
-- ----------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'track_status') then
    create type track_status as enum ('queued', 'processing', 'completed', 'failed');
  end if;
end$$;

-- ----------------------------------------------------------
-- 2. tracks table
-- ----------------------------------------------------------
create table if not exists public.tracks (
  id                uuid primary key default gen_random_uuid(),
  youtube_id        varchar(11) not null unique,
  title             text,
  status            track_status not null default 'queued',
  bpm               real,
  vocals_url        text,
  instrumental_url  text,
  matrix_json_url   text,
  error_message     text,
  -- worker locking bookkeeping
  locked_by         text,
  locked_at         timestamptz,
  attempts          int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_tracks_status      on public.tracks (status);
create index if not exists idx_tracks_youtube_id  on public.tracks (youtube_id);

-- ----------------------------------------------------------
-- 3. updated_at trigger
-- ----------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tracks_updated_at on public.tracks;
create trigger trg_tracks_updated_at
before update on public.tracks
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------
-- 4. Atomic job claim (SELECT ... FOR UPDATE SKIP LOCKED)
--
-- Multiple local workers can call this concurrently and will
-- never grab the same row: the row lock is held for the
-- duration of the function's implicit transaction, so a
-- second caller's SKIP LOCKED simply moves on to the next
-- queued row (or returns nothing).
-- ----------------------------------------------------------
create or replace function public.claim_next_track(p_worker_id text)
returns setof public.tracks
language plpgsql
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.tracks
  where status = 'queued'
  order by created_at asc
  for update skip locked
  limit 1;

  if v_id is null then
    return; -- nothing to claim
  end if;

  update public.tracks
  set status     = 'processing',
      locked_by  = p_worker_id,
      locked_at  = now(),
      attempts   = attempts + 1
  where id = v_id;

  return query select * from public.tracks where id = v_id;
end;
$$;

-- ----------------------------------------------------------
-- 5. Helper RPC: requeue jobs stuck in 'processing' past a
--    timeout (e.g. worker crashed mid-job). Call this
--    periodically (cron, or at worker startup).
-- ----------------------------------------------------------
create or replace function public.requeue_stale_jobs(p_timeout_minutes int default 30)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  with stale as (
    update public.tracks
    set status = 'queued',
        locked_by = null,
        locked_at = null
    where status = 'processing'
      and locked_at < now() - (p_timeout_minutes || ' minutes')::interval
    returning id
  )
  select count(*) into v_count from stale;

  return v_count;
end;
$$;

-- ----------------------------------------------------------
-- 6. Row Level Security
--
-- The Next.js app reads tracks with the anon key (public
-- read of completed tracks is fine). Inserts/updates of the
-- queue happen via Server Actions using the service_role key
-- (which bypasses RLS), or you can relax the insert policy
-- below if you prefer the anon key to enqueue jobs directly.
-- ----------------------------------------------------------
alter table public.tracks enable row level security;

drop policy if exists "Public read access" on public.tracks;
create policy "Public read access"
  on public.tracks for select
  using (true);

-- Uncomment if you want client-side / anon-key inserts instead
-- of routing inserts through a service-role Server Action:
--
-- drop policy if exists "Public insert access" on public.tracks;
-- create policy "Public insert access"
--   on public.tracks for insert
--   with check (true);
