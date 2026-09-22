/**
 * Aalto's one server-side component.
 *
 * It serves the page, and it mints session tokens under a budget. That is the
 * whole of it - the audio socket is browser-to-AssemblyAI, so nothing here is
 * ever on the hot path of a conversation, and a cold start costs a token
 * request rather than a stutter mid-sentence.
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

    if (!url.pathname.startsWith("/api/")) {
      // Everything that is not the API is the site, served by the assets binding.
      return env.ASSETS.fetch(request);
    }

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

    // The installed extension's way in, for anyone who has not brought their
    // own key. Deliberately a GET with no custom headers: that skips the
    // preflight entirely, and there is no OPTIONS handler to get wrong.
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

function ledger(env: Env) {
  // One ledger for everyone: a per-visitor object would enforce nothing, since
  // the point of the daily cap is the total across visitors.
  return env.DEMO_BUDGET.get(env.DEMO_BUDGET.idFromName("global"));
}

async function status(env: Env, forExtension: boolean): Promise<Response> {
  const { dailyCap } = limits(env, forExtension);
  const state = await ledger(env).status(today(), dailyCap);
  return json({ ...state, mode: state.remainingSeconds > 0 ? "live" : "replay" });
}

/**
 * Hand out one session.
 *
 * Order matters: the cheap shield first, then the ledger, and only then the
 * upstream call. Minting before taking the lease would spend a token on a
 * request the budget was about to refuse.
 */
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
    await ledger(env).release(leaseId, today(), 0);
    throw err;
  }
}

/**
 * Refund the unused part of a lease.
 *
 * Arrives via sendBeacon on pagehide, which sets its own content type and
 * cannot be relied on to send JSON headers - so the body is parsed as text and
 * a failure to parse is not worth a 400 to a client that has already navigated
 * away.
 */
async function release(request: Request, env: Env): Promise<Response> {
  let body: { leaseId?: string; durationSeconds?: number } = {};
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ ok: true });
  }
  if (body.leaseId) {
    await ledger(env).release(body.leaseId, today(), Math.max(0, body.durationSeconds ?? 0));
  }
  return json({ ok: true });
}

// --- plumbing ---------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A cached token would be a token already spent.
      "cache-control": "no-store",
    },
  });
}

/**
 * The demo is same-origin and needs none of this. It exists for the extension,
 * whose service-worker fetches really are cross-origin and really do send an
 * Origin header - and which is why the extension's ID is pinned, so there is a
 * fixed value to allow.
 */
function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (origin !== EXTENSION_ORIGIN) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
