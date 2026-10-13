-- 0004_cron.sql : release expired slot reservations every minute (needs pg_cron).
-- Enable first: Dashboard -> Database -> Extensions -> pg_cron.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule('release-expired-reservations')
    where exists (select 1 from cron.job where jobname = 'release-expired-reservations');
  perform cron.schedule('release-expired-reservations', '* * * * *',
    $cron$ select public.release_expired_reservations(); $cron$);
exception when others then
  raise notice 'pg_cron not available (%). Enable it, or schedule the release-expired-slots Edge Function instead.', sqlerrm;
end $$;
