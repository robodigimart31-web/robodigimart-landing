-- HELIX VIP licensing foundation. Run after schema.sql in Supabase SQL Editor.
-- Secrets and service-role access stay server-side; the browser never receives these tables directly.
create extension if not exists pgcrypto;

create type public.helix_license_status as enum ('active','suspended','revoked','expired');
create type public.helix_event_type as enum ('created','activated','sync','reset','suspended','revoked','expired','email');

create table if not exists public.helix_members (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null,
  role text not null default 'member' check (role in ('member','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.helix_licenses (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.helix_members(id) on delete cascade,
  product_slug text not null references public.helix_series(slug),
  license_key_hash text not null unique,
  license_key_hint text not null,
  status public.helix_license_status not null default 'active',
  expires_at timestamptz not null,
  max_accounts smallint not null default 5 check (max_accounts between 1 and 50),
  entitlement_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists helix_licenses_member_idx on public.helix_licenses(member_id,status);

create table if not exists public.helix_license_bindings (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.helix_licenses(id) on delete cascade,
  broker_server text not null,
  account_login text not null,
  account_fingerprint text not null,
  mode text not null default 'real' check (mode in ('real','demo')),
  alias text not null default '',
  first_seen_at timestamptz not null default now(),
  last_sync_at timestamptz not null default now(),
  released_at timestamptz,
  unique (license_id,account_fingerprint)
);
create index if not exists helix_bindings_active_idx on public.helix_license_bindings(license_id) where released_at is null;

create table if not exists public.helix_license_events (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.helix_licenses(id) on delete cascade,
  actor_id uuid references auth.users(id),
  event_type public.helix_event_type not null,
  binding_id uuid references public.helix_license_bindings(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists helix_events_license_idx on public.helix_license_events(license_id,created_at desc);

create table if not exists public.helix_announcements (
  id uuid primary key default gen_random_uuid(), title text not null, body text not null,
  kind text not null default 'update', published boolean not null default false,
  published_at timestamptz, created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.helix_materials (
  id uuid primary key default gen_random_uuid(), title text not null, description text not null default '',
  kind text not null default 'guide', storage_path text, published boolean not null default false,
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);

alter table public.helix_members enable row level security;
alter table public.helix_licenses enable row level security;
alter table public.helix_license_bindings enable row level security;
alter table public.helix_license_events enable row level security;
alter table public.helix_announcements enable row level security;
alter table public.helix_materials enable row level security;
revoke all on public.helix_members,public.helix_licenses,public.helix_license_bindings,public.helix_license_events,public.helix_announcements,public.helix_materials from anon,authenticated;

-- All mutations run through authenticated server functions/API routes using service_role.
create or replace function public.helix_active_slot_count(p_license uuid)
returns integer language sql stable security definer set search_path=public as $$
  select count(*)::integer from public.helix_license_bindings where license_id=p_license and released_at is null;
$$;
revoke all on function public.helix_active_slot_count(uuid) from public,anon,authenticated;

create or replace function public.helix_touch_binding(p_license uuid,p_server text,p_login text,p_mode text default 'real')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_license public.helix_licenses; v_binding public.helix_license_bindings; v_fp text; v_count integer;
begin
  select * into v_license from public.helix_licenses where id=p_license for update;
  if not found or v_license.status <> 'active' or v_license.expires_at <= now() then raise exception 'License is not active'; end if;
  v_fp := encode(digest(lower(trim(p_server))||':'||trim(p_login),'sha256'),'hex');
  select * into v_binding from public.helix_license_bindings where license_id=p_license and account_fingerprint=v_fp for update;
  if found then update public.helix_license_bindings set last_sync_at=now(),released_at=null where id=v_binding.id returning * into v_binding;
  else select public.helix_active_slot_count(p_license) into v_count; if v_count >= v_license.max_accounts then raise exception 'Account slot limit reached'; end if;
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode) values(p_license,p_server,p_login,p_mode,v_fp) returning * into v_binding;
  end if;
  insert into public.helix_license_events(license_id,event_type,binding_id,metadata) values(p_license,'sync',v_binding.id,jsonb_build_object('server',p_server,'login',p_login));
  return jsonb_build_object('status','active','license_id',p_license,'binding_id',v_binding.id,'entitlement_version',v_license.entitlement_version);
end; $$;
revoke all on function public.helix_touch_binding(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.helix_touch_binding(uuid,text,text,text) to service_role;
