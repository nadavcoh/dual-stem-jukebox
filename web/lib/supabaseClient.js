import { createClient } from "@supabase/supabase-js";

// Safe for client components: the anon key only ever has the
// "Public read access" SELECT policy from supabase/migrations/.
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
