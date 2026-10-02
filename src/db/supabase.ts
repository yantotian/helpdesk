import { createClient } from "@supabase/supabase-js";

const SUPABASE_HOST_PATTERN = /\.supabase\.(co|in)$/i;

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not set. Add it to .env for local runs, or as a repository variable for CI, then rebuild.`,
    );
  }
  return trimmed;
}

function resolveSupabaseUrl(value: string | undefined): string {
  const raw = requireEnv(value, "VITE_SUPABASE_URL").replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`VITE_SUPABASE_URL is not a valid URL: "${raw}"`);
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `VITE_SUPABASE_URL must not include a path (got "${parsed.pathname}"). Use the project origin only, e.g. https://<project-ref>.supabase.co`,
    );
  }

  if (!SUPABASE_HOST_PATTERN.test(parsed.hostname)) {
    throw new Error(
      `VITE_SUPABASE_URL points at "${parsed.hostname}", which is not a Supabase host. Requests to it will return HTML and login will fail. Expected https://<project-ref>.supabase.co`,
    );
  }

  return parsed.origin;
}

export const supabase = createClient(
  resolveSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
  requireEnv(import.meta.env.VITE_SUPABASE_ANON_KEY, "VITE_SUPABASE_ANON_KEY"),
);
