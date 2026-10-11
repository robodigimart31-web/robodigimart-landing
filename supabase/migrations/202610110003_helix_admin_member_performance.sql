-- Admin-only aggregate over every completed account/license position per member.
-- Read-only and safe to rerun. This does not activate telemetry or add allowlisted magic values.
create index if not exists helix_licenses_member_id_idx on public.helix_licenses(member_id,id);

create or replace function public.helix_admin_member_performance_summary(p_actor_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then
    return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED');
  end if;

  with member_accounts as (
    select l.member_id,count(distinct b.id)::integer as account_count
    from public.helix_licenses l
    join public.helix_license_bindings b on b.license_id=l.id
    group by l.member_id
  ), binding_sync as (
    select binding_id,max(last_telemetry_sync_at) as last_sync_at
    from public.helix_license_sessions group by binding_id
  ), member_stats as (
    select l.member_id,
      count(t.id)::integer as total_closed_trades,
      count(*) filter(where t.outcome='win')::integer as wins,
      count(*) filter(where t.outcome='loss')::integer as losses,
      count(*) filter(where t.outcome='break_even')::integer as break_even,
      count(distinct t.currency)::integer as currency_count,
      min(t.currency) as only_currency,
      sum(t.net_pnl) as net_profit,
      coalesce(sum(t.net_pnl) filter(where t.net_pnl>0),0) as gross_profit,
      abs(coalesce(sum(t.net_pnl) filter(where t.net_pnl<0),0)) as gross_loss,
      max(bs.last_sync_at) as last_sync_at
    from public.helix_completed_trades t
    join public.helix_license_bindings b on b.id=t.binding_id
    join public.helix_licenses l on l.id=b.license_id
    left join binding_sync bs on bs.binding_id=b.id
    group by l.member_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id',m.id,
    'status',case when coalesce(s.total_closed_trades,0)=0 then 'NO_DATA'
      when s.currency_count>1 then 'MIXED_CURRENCY' else 'READY' end,
    'total_closed_trades',coalesce(s.total_closed_trades,0),
    'account_count',coalesce(a.account_count,0),
    'wins',coalesce(s.wins,0),'losses',coalesce(s.losses,0),'break_even',coalesce(s.break_even,0),
    'winrate',case when coalesce(s.total_closed_trades,0)>0 then round(s.wins::numeric/s.total_closed_trades*100,2) else null end,
    'net_profit',case when s.currency_count=1 then round(s.net_profit,2) else null end,
    'gross_profit',case when s.currency_count=1 then round(s.gross_profit,2) else null end,
    'gross_loss',case when s.currency_count=1 then round(s.gross_loss,2) else null end,
    'profit_factor',case when s.currency_count=1 and s.gross_loss>0 then round(s.gross_profit/s.gross_loss,4) else null end,
    'currency',case when s.currency_count=1 then s.only_currency when s.currency_count>1 then 'MIXED' else null end,
    'last_sync_at',s.last_sync_at
  ) order by m.created_at desc),'[]'::jsonb)
  into v_result
  from public.helix_members m
  left join member_stats s on s.member_id=m.id
  left join member_accounts a on a.member_id=m.id
  where m.role='member';

  return jsonb_build_object('ok',true,'status','READY','members',v_result);
end;
$$;

revoke all on function public.helix_admin_member_performance_summary(uuid) from public,anon,authenticated;
grant execute on function public.helix_admin_member_performance_summary(uuid) to service_role;
