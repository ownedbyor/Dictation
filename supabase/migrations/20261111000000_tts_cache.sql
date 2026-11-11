-- Public bucket for cached speech clips (WAV). Only the dictation-tts Edge Function (service role) writes to it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tts', 'tts', true, 5242880, array['audio/wav'])
on conflict (id) do nothing;

-- Background pre-rendering of the fixed phrases (phrases.js). Rows are inserted from PH.all(...);
-- the cron job 'tts-warm' sends 20 missing clips every 2 minutes and unschedules itself when done:
--   select cron.schedule('tts-warm', '*/2 * * * *', $$select private.tts_warm_tick()$$);
create schema if not exists private;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pgcrypto with schema extensions;

create table if not exists private.tts_warm (
  ord int primary key,
  text text not null,
  lang text not null check (lang in ('he', 'en'))
);

create or replace function private.tts_object_name(p_text text, p_lang text, p_voice text default 'Kore')
returns text language sql immutable as $$
  select p_lang || '/' || encode(extensions.digest(convert_to('|' || p_voice || '|' || p_lang || '|' || p_text, 'UTF8'), 'sha256'), 'hex') || '.wav';
$$;
-- private.tts_warm_tick(): see the live definition (selects up to 20 rows not yet in storage.objects and
-- posts them to /functions/v1/dictation-tts as { warm: [...] } with pg_net).
