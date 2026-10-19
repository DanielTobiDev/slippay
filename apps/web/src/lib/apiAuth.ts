import { supabase } from "./auth.tsx";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  // Normalise through the Headers API so objects, Headers instances, and
  // array-of-pairs inputs all merge identically. Spreading only works for
  // plain objects and silently drops everything else.
  const headers = new Headers(init.headers);
  // The session token always wins over a caller-supplied authorization
  // header, so a stale or forged token cannot override the authenticated
  // session.
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
}
