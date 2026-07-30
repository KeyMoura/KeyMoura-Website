-- DESTRUCTIVE rollback: export moderation_recycle_bin before running.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'purge-expired-moderation-recycle-bin';
  end if;
end;
$$;
drop function if exists public.purge_expired_moderation_recycle_bin();
drop index if exists public.reports_escalated_at_idx;
alter table public.reports drop column if exists escalated_by, drop column if exists escalated_at;
drop table if exists public.moderation_recycle_bin;
