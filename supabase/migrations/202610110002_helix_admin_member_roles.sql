-- Incremental production migration: audited admin/member role changes.
-- Safe to rerun. Apply through Supabase SQL Editor after reviewing the affected project.
create table if not exists public.helix_member_role_audit (
  id uuid primary key default gen_random_uuid(),
  -- Keep immutable audit identifiers even if a member is later removed.
  actor_id uuid not null,
  target_member_id uuid not null,
  old_role text not null check (old_role in ('admin','member')),
  new_role text not null check (new_role in ('admin','member')),
  reason text not null check (length(trim(reason)) between 3 and 300),
  created_at timestamptz not null default now()
);
alter table public.helix_member_role_audit enable row level security;
revoke all on public.helix_member_role_audit from anon, authenticated;
grant all on public.helix_member_role_audit to service_role;

create or replace function public.helix_admin_set_member_role(
  p_target_member_id uuid,
  p_actor_id uuid,
  p_role text,
  p_reason text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_target public.helix_members; v_old_role text; v_admin_count integer;
begin
  if p_role not in ('admin','member') then return jsonb_build_object('ok',false,'error_code','INVALID_ROLE'); end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  perform pg_advisory_xact_lock(hashtext('helix_member_role_change'));
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if p_target_member_id=p_actor_id then return jsonb_build_object('ok',false,'error_code','SELF_ROLE_CHANGE_BLOCKED'); end if;
  select * into v_target from public.helix_members where id=p_target_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  v_old_role:=v_target.role;
  if v_old_role=p_role then return jsonb_build_object('ok',true,'unchanged',true,'role',v_old_role); end if;
  if v_old_role='admin' and p_role='member' then
    select count(*) into v_admin_count from public.helix_members where role='admin';
    if v_admin_count<=1 then return jsonb_build_object('ok',false,'error_code','LAST_ADMIN'); end if;
  end if;
  update public.helix_members set role=p_role,updated_at=now() where id=p_target_member_id;
  insert into public.helix_member_role_audit(actor_id,target_member_id,old_role,new_role,reason)
    values(p_actor_id,p_target_member_id,v_old_role,p_role,trim(p_reason));
  return jsonb_build_object('ok',true,'role',p_role,'old_role',v_old_role);
end;
$$;
revoke all on function public.helix_admin_set_member_role(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.helix_admin_set_member_role(uuid,uuid,text,text) to service_role;
