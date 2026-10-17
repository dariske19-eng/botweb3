-- Drizz JadiBot — jalankan di Supabase SQL Editor

-- Profil pengguna (link ke auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now()
);

-- Kod claim (6 digit, sekali guna)
create table if not exists public.codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  duration_days int not null default 30,
  expires_at timestamptz not null,
  used boolean not null default false,
  used_by uuid references auth.users(id),
  used_at timestamptz,
  created_by text default 'admin',
  created_at timestamptz default now(),
  note text
);

create index if not exists codes_code_idx on public.codes(code);

-- Instance bot pembeli
create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  code_id uuid references public.codes(id),
  name text default 'My Bot',
  status text not null default 'stopped', -- stopped | pending_qr | pending_pair | running | expired | error
  enabled boolean not null default true,
  phone text,
  session_id text,
  pair_code text,
  qr_data text,
  expires_at timestamptz not null,
  features jsonb not null default '{
    "welcome": false,
    "games": true,
    "sticker": true,
    "media": true,
    "tools": true,
    "fun": true,
    "group": true,
    "ai_img": true,
    "download": true
  }'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists bots_owner_idx on public.bots(owner_id);
create index if not exists bots_status_idx on public.bots(status);

-- Auto profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.codes enable row level security;
alter table public.bots enable row level security;

create policy "profiles read own" on public.profiles for select using (auth.uid() = id);
create policy "profiles update own" on public.profiles for update using (auth.uid() = id);

-- codes: hanya service role / server (tiada policy user)
-- bots: owner boleh baca/kemaskini sendiri
create policy "bots read own" on public.bots for select using (auth.uid() = owner_id);
create policy "bots update own" on public.bots for update using (auth.uid() = owner_id);
