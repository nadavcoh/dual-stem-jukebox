import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server Actions / Route Handlers only. The service role key bypasses
// RLS, so this file must never be imported from a Client Component.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
