-- Close the TRUNCATE hole in the support tables.
--
-- WHAT WAS WRONG
--
-- `20260810100000_support_conversations` revoked everything from `public`,
-- `anon` and `authenticated`, then granted `service_role` exactly what it needs.
-- What it did not do is revoke the privileges Supabase's **default privileges**
-- hand `service_role` on every new table in `public` — and one of them is
-- `TRUNCATE`.
--
-- That matters here more than it looks. `support_messages_no_rewrite` is a
-- `BEFORE DELETE ... FOR EACH ROW` trigger, and **a row trigger does not fire on
-- TRUNCATE**. So the table advertised as append-only could have been emptied in
-- one statement by anything holding the service key: the DELETE was refused, the
-- wholesale erasure was not.
--
-- Found by re-reading the grants in production after applying, which is the only
-- reason it was found at all — the dry-run probes tested DELETE and UPDATE, and
-- both were correctly refused.
--
-- `audit_logs` already closes this (pass 20 states "UPDATE, DELETE and TRUNCATE
-- are all refused"). This brings the support tables to the same standard.
--
-- REVOKE-ONLY. No table, column, policy or row is touched. Nothing gains a
-- privilege; two things lose one.

begin;

-- The append-only one. This is the load-bearing revoke.
revoke truncate on public.support_messages from service_role;

-- The conversation row is legitimately mutable — status, priority, assignment —
-- but "delete every support conversation" is not an operation this application
-- has, and the DELETE grant was already withheld for that reason. TRUNCATE is
-- the same operation by another name.
revoke truncate on public.support_conversations from service_role;

-- The view carries no rows of its own; revoked for symmetry so the grant listing
-- reads the same way for all three objects.
revoke truncate on public.staff_support_queue from service_role;

notify pgrst, 'reload schema';

commit;
