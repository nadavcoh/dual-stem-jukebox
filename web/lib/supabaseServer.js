import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server Actions / Route Handlers only. The secret key bypasses RLS, so
// this file must never be imported from a Client Component.
//
// Supabase is deprecating the legacy JWT-based anon/service_role keys in
// favor of opaque publishable (sb_publishable_...) / secret (sb_secret_...)
// keys — same permissions, but independently rotatable/revocable. The SDK
// accepts either format with zero code changes here; only the env var
// (and the value you put in it) changed.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false } }
  );
}
