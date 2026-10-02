const NON_JSON_PATTERN =
  /unexpected token|is not valid json|json parse|unexpected end of json/i;

const NETWORK_PATTERN = /failed to fetch|networkerror|network request failed|load failed/i;

export const NON_JSON_RESPONSE_MESSAGE =
  "Cannot reach the Supabase API: the server returned a web page instead of JSON. Check that VITE_SUPABASE_URL points to your Supabase project origin.";

export const NETWORK_ERROR_MESSAGE =
  "Cannot reach the authentication server. Check your connection and try again.";

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function describeAuthError(error: unknown): string {
  const message = messageOf(error);

  if (NON_JSON_PATTERN.test(message)) return NON_JSON_RESPONSE_MESSAGE;
  if (NETWORK_PATTERN.test(message)) return NETWORK_ERROR_MESSAGE;

  return message || "Authentication failed.";
}
