import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client;

if (url && anonKey) {
  client = createClient(url, anonKey);
} else {
  // No keys yet → run in "local-only" mode so the game still works (no accounts).
  // This lets you deploy and test before Supabase is fully configured.
  console.warn(
    "Supabase keys missing. Running local-only (no accounts). " +
      "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env (local) " +
      "and in Cloudflare Pages → Settings → Environment variables (production)."
  );
  const notConfigured = async () => ({
    data: {},
    error: new Error("Accounts aren’t set up yet."),
  });
  client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe() {} } },
      }),
      signUp: notConfigured,
      signInWithPassword: notConfigured,
      signInWithOAuth: notConfigured,
      signOut: async () => ({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      upsert: async () => ({ error: null }),
    }),
  };
}

export const supabase = client;
