-- Fix existing league_tournaments rows whose picks_lock_at was set to the event
-- end_date (old buggy default). Reset to start_date.

update league_tournaments lt
set picks_lock_at = (t.start_date::timestamp at time zone 'UTC')
from tournaments t
where lt.tournament_id = t.id
  and lt.picks_lock_at is not null
  and t.start_date is not null
  and lt.picks_lock_at::date >= t.end_date;
