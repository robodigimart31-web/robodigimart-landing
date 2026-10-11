# Member profile, role, and suspended-license actions

## What the role error means

The Member page already has the role-change control and the API calls the audited `helix_admin_set_member_role` function. Production returned `ROLE_MIGRATION_REQUIRED` because migration `202610110002_helix_admin_member_roles.sql` has not been installed in the connected Supabase database. The source change alone cannot create that database function.

## Apply the required migrations manually

1. Open Supabase Dashboard for the project used by the HELIX portal, then open **SQL Editor**.
2. Create a new query, copy the complete contents of `supabase/migrations/202610110002_helix_admin_member_roles.sql`, review it, and run it once. It creates a protected role-audit table and audited role RPC; it does not change any user role.
3. In a separate query, run `supabase/migrations/202610110003_helix_member_license_suspend.sql`. It adds restricted suspension state and license-snapshot tables plus an admin-only RPC that blocks current portal API sessions, suspends licenses, and revokes EA sessions in one database transaction.
4. Run this read-only verification:

```sql
select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('helix_admin_set_member_role','helix_admin_set_member_suspended');
```

Both functions should exist, anon/authenticated should be false, and service_role should be true. Do not paste secrets or customer data into chat.

## Name changes

Members can edit their own display name from **My Profile**. An authenticated server route uses the member ID from the verified session, validates the name, and updates only that member's `helix_members.display_name`. Admins can update their own name from the Admin Portal header. Other members' names cannot be changed through this route.

## Suspend, restore, and delete behavior

Once migration `202610110003` is installed, the Admin Portal suspends a member's currently active licenses, increments entitlement versions, revokes their terminal session proofs, and records the suspended member ID so already-issued portal JWTs are refused by portal APIs. New pairing and sync requests are rejected while those licenses are suspended. Restore reactivates only the licenses that were active before member suspension; pre-existing suspended/revoked/expired licenses keep their state. Restored members must pair their terminal again because old session proofs remain revoked.

Deleting a member calls the account admin delete API. The licensing schema declares cascading foreign keys from Auth user to `helix_members`, member to licenses, and license to bindings/sessions/trades, so the related license/session data is removed with the account. Retained independent audit rows may remain. A signed entitlement already cached by an offline EA can remain usable until its configured offline grace expires; server sync is blocked immediately after the migration's session revocation. Auth user bans alone only block sign-in and do not revoke existing access tokens, so the database suspension guard is required too.

If either migration is missing, the updated API returns a clear migration-required error and does not report a successful license suspension. Database changes are not performed by this deployment; run these SQL migrations manually.
