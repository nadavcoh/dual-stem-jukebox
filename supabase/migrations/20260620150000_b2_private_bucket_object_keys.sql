-- =============================================================
-- Migrate from public B2 URLs to private-bucket object keys.
--
-- The B2 bucket is moving from public to private (a public bucket
-- requires a credit card on file). Supabase no longer stores a
-- directly-fetchable URL for each stem/matrix file — it stores the raw
-- S3 object key, and the Next.js app exchanges that key for a
-- short-lived presigned URL at the moment it's actually needed
-- (web/lib/b2Presign.js).
-- =============================================================

alter table public.tracks rename column vocals_url to vocals_key;
alter table public.tracks rename column instrumental_url to instrumental_key;
alter table public.tracks rename column matrix_json_url to matrix_json_key;

comment on column public.tracks.vocals_key is
  'B2/S3 object key (relative path), e.g. "{youtube_id}/vocals.mp3" — NOT a public URL. Exchange for a presigned URL via web/lib/b2Presign.js before fetching.';
comment on column public.tracks.instrumental_key is
  'B2/S3 object key (relative path), e.g. "{youtube_id}/instrumental.mp3" — NOT a public URL.';
comment on column public.tracks.matrix_json_key is
  'B2/S3 object key (relative path), e.g. "{youtube_id}/matrix.json" — NOT a public URL.';
