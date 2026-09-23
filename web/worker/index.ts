/**
 * Serves the page and mints session tokens under a budget. That is all of it -
 * the audio socket is browser-to-AssemblyAI, so nothing here is on the hot path
 * of a conversation.
 */

import { DemoBudget } from "./budget.js";
import { hashVisitor, today } from "./iphash.js";
import { mintToken } from "./token.js";

export { DemoBudget };

/** The extension's pinned ID - see extension/manifest.json's `key`. */
const EXTENSION_ORIGIN = "chrome-extension://kpfmcjoapodehdolgeohbpbickdmejko";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const response = await route(request, env, url);
      return withCors(response, request);
    } catch (err) {
      console.error(err);
      return withCors(json({ error: "something went wrong" }, 500), request);
    }
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/health":
      return json({ ok: true, version: "1.0.0" });

    case "GET /api/demo/status":
      return await status(env, false);

    case "POST /api/demo/token":
      return await token(request, env, false);

    case "POST /api/demo/release":
      return await release(request, env);

    // A GET with no custom headers, so there is no preflight to get wrong.
    case "GET /api/ext/token":
      return await token(request, env, true);

    case "OPTIONS /api/demo/token":
    case "OPTIONS /api/demo/release":
      return new Response(null, { status: 204 });

    default:
      return json({ error: "no such endpoint" }, 404);
  }
}

// --- handlers ---------------------------------------------------------------

function limits(env: Env, forExtension: boolean) {
  return forExtension
    ? {
        seconds: Number(env.EXT_MAX_SESSION_SECONDS),
        dailyCap: Number(env.EXT_DAILY_CAP_SECONDS),
      }
    : { seconds: Number(env.MAX_SESSION_SECONDS), dailyCap: Number(env.DAILY_CAP_SECONDS) };
}

/** One ledger for everyone: the daily cap is a total across visitors. */
function ledger(env: Env) {
  return env.DEMO_BUDGET.get(env.DEMO_BUDGET.idFromName("global"));
}

async function status(env: Env, forExtension: boolean): Promise<Response> {
  const { dailyCap } = limits(env, forExtension);
  const state = await ledger(env).status(today(), dailyCap);
  return json({ ...state, mode: state.remainingSeconds > 0 ? "live" : "replay" });
}

/** Cheap shield, then ledger, then upstream - minting first would spend a
 *  token on a request the budget was about to refuse. */
async function token(request: Request, env: Env, forExtension: boolean): Promise<Response> {
  const { seconds, dailyCap } = limits(env, forExtension);
  const visitor = await hashVisitor(request, env.ASSEMBLYAI_API_KEY);

  const { success } = await env.DEMO_RL.limit({ key: visitor });
  if (!success) return json({ reason: "burst" }, 429);

  const lease = await ledger(env).mint(visitor, today(), seconds, dailyCap);
  if (!lease.ok || !lease.leaseId) return json({ reason: lease.reason ?? "daily_limit" }, 429);
  const leaseId = lease.leaseId;

  try {
    const token = await mintToken(env.ASSEMBLYAI_API_KEY, seconds);
    return json({ token, leaseId, maxSessionSeconds: seconds });
  } catch (err) {
    // Give the seconds back rather than charging for a session that never
    // opened - otherwise an upstream outage silently eats the day's budget.
    await ledger(env).cancel(leaseId, today());
    console.error("mint failed:", err);
    // A named reason and its own status, so the page can say what actually
    // happened. Falling through to the generic 500 meant an upstream failure
    // and a missing key both reported to the user as rate limiting.
    return json({ reason: "upstream" }, 503);
  }
}

/** Arrives via sendBeacon, which sets its own content type - so the body is
 *  parsed as text, and a parse failure is not worth a 400 to a client that has
 *  already navigated away. */
async function release(request: Request, env: Env): Promise<Response> {
  let body: { leaseId?: string } = {};
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ ok: true });
  }
  // Frees the slot so this visitor can start again. It does not give the
  // seconds back - see the note on release().
  if (body.leaseId) await ledger(env).release(body.leaseId);
  return json({ ok: true });
}

// --- plumbing ---------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: a cached token is a token already spent.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** For the extension only - the demo is same-origin. Its ID is pinned in the
 *  manifest precisely so there is a fixed origin to allow. */
function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (origin !== EXTENSION_ORIGIN) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
