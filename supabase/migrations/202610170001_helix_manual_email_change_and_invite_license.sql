-- Manual email-change completion for the HELIX admin workflow.
-- The application validates the member password before creating the request.
create or replace function public.helix_email_change_complete(
  p_request_id uuid,
  p_actor_id uuid,
  p_note text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_request public.helix_email_change_requests;
begin
  select * into v_request
  from public.helix_email_change_requests
  where id = p_request_id
  for update;
  if not found then return jsonb_build_object('ok',false,'error_code','REQUEST_NOT_FOUND'); end if;
  if v_request.status <> 'pending' then return jsonb_build_object('ok',false,'error_code','REQUEST_NOT_PENDING'); end if;
  if v_request.expires_at <= now() then
    update public.helix_email_change_requests set status='expired' where id=v_request.id;
    return jsonb_build_object('ok',false,'error_code','REQUEST_EXPIRED');
  end if;
  update public.helix_email_change_requests
    set status='completed', admin_actor=p_actor_id, admin_note=left(coalesce(p_note,''),300), decided_at=now(), verified_at=now()
    where id=v_request.id;
  return jsonb_build_object('ok',true,'status','completed','member_id',v_request.member_id,'new_email',v_request.new_email);
end $$;

revoke all on function public.helix_email_change_complete(uuid,uuid,text) from public;
grant execute on function public.helix_email_change_complete(uuid,uuid,text) to service_role;
