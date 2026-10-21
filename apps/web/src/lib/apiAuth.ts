import { supabase } from "./auth.tsx";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  // Normalise through the Headers API so objects, Headers instances, and
  // array-of-pairs all merge identically. Object spreading dropped Headers
  // instances entirely.
  const headers = new Headers(init.headers);
  // A session token always wins over a caller-supplied authorization header.
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
}
