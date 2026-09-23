// Single-use tokens, capped at issue - the only point a cap can be enforced,
// since after that the socket is browser-to-AssemblyAI with nothing in between.

// The API-spec page also documents POST /v1/voice-agent/token on
// api.assemblyai.com; that 404s. This one exists, and auth is the bare key.
const MINT_URL = "https://agents.assemblyai.com/v1/token";

export async function mintToken(apiKey: string, maxSessionSeconds: number): Promise<string> {
  const url = new URL(MINT_URL);
  url.searchParams.set("expires_in_seconds", "120");
  url.searchParams.set("max_session_duration_seconds", String(maxSessionSeconds));

  const res = await fetch(url, { headers: { authorization: apiKey } });
  // Never pass the upstream body through: on a bad key it names the key.
  if (!res.ok) throw new Error(`AssemblyAI refused to mint a token (${res.status})`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("AssemblyAI returned no token");
  return body.token;
}
