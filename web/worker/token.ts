/**
 * Minting session tokens.
 *
 * The API key never leaves the Worker. What the browser gets is a single-use
 * token good for one session, capped in length at the moment it is issued -
 * which is the only point at which the cap can be enforced, since after that
 * the socket is between the browser and AssemblyAI with nothing in between.
 */

/**
 * Verified against the live API. The API-spec page also documents a
 * POST /v1/voice-agent/token on api.assemblyai.com; that path 404s. This is the
 * one that exists, it is a GET, and auth is the bare key in an `authorization`
 * header rather than a bearer token.
 */
const MINT_URL = "https://agents.assemblyai.com/v1/token";

export async function mintToken(apiKey: string, maxSessionSeconds: number): Promise<string> {
  const url = new URL(MINT_URL);
  url.searchParams.set("expires_in_seconds", "120");
  url.searchParams.set("max_session_duration_seconds", String(maxSessionSeconds));

  const res = await fetch(url, { headers: { authorization: apiKey } });
  if (!res.ok) {
    // Never pass the upstream body through: on a bad key it names the key.
    throw new Error(`AssemblyAI refused to mint a token (${res.status})`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("AssemblyAI returned no token");
  return body.token;
}
