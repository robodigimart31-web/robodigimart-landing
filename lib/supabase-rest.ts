// Server-side ONLY. Do not import this module into client components.
import "server-only";
const root = process.env.SUPABASE_URL?.replace(/\/$/, "");
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const databaseConfigured = Boolean(root && secret && !root?.includes("YOUR_PROJECT") && !secret?.startsWith("YOUR_"));

export async function dbRequest<T>(tableAndQuery: string, method: "GET" | "POST" = "GET", body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  if (!databaseConfigured || !root || !secret) throw new Error("Database belum dikonfigurasi");
  const response = await fetch(`${root}/rest/v1/${tableAndQuery}`, {
    method,
    headers: {
      apikey: secret,
      ...(secret.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${secret}` }),
      "Content-Type": "application/json",
      ...(method === "POST" ? { Prefer: "resolution=merge-duplicates,return=representation" } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  if (!response.ok) {
    // Deliberately avoid echoing SQL, credentials, sensitive input, or response body.
    throw new Error(`Database operation failed (HTTP ${response.status})`);
  }
  // PostgREST functions returning void may respond with 204 or an empty body.
  if (response.status === 204) return null as T;
  const content = await response.text();
  return (content ? JSON.parse(content) : null) as T;
}
