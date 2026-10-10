-- Run after inviting widya.amandha@gmail.com from Supabase Authentication > Users.
-- This grants admin role by matching the verified Auth user email.
insert into public.helix_members(id,display_name,email,role)
select id,coalesce(raw_user_meta_data->>'full_name','Widya Amandha'),email,'admin'
from auth.users
where lower(email)=lower('widya.amandha@gmail.com')
on conflict(id) do update set role='admin',updated_at=now();

do $$ begin
  if not exists(select 1 from auth.users where lower(email)=lower('widya.amandha@gmail.com')) then
    raise notice 'Invite widya.amandha@gmail.com first, then run this query again.';
  end if;
end $$;
