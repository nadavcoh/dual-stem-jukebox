-- =============================================================
-- Add detected musical key columns, used by the player's "pitch shift to
-- match key" feature (see lib/audioEngine.js's setKeyMatch()).
--
-- key_pitch_class: 0-11, 0 = C, following standard pitch-class numbering.
-- key_is_major: true for major, false for minor. Detected via
-- Krumhansl-Schmuckler key-finding against the instrumental stem's
-- aggregated chroma profile (worker/worker.py's detect_key()).
-- =============================================================

alter table public.tracks add column if not exists key_pitch_class smallint;
alter table public.tracks add column if not exists key_is_major boolean;

comment on column public.tracks.key_pitch_class is
  'Detected musical key, 0-11 (0=C), via Krumhansl-Schmuckler on the instrumental stem. Null if not yet processed.';
comment on column public.tracks.key_is_major is
  'true = major, false = minor. Paired with key_pitch_class.';
