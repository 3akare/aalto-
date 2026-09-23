/** Tell visitors apart without storing who they are. The salt rotates daily,
 *  so the hash cannot be walked back to an address or followed across days. */
export async function hashVisitor(request: Request, secret: string): Promise<string> {
  // Not X-Forwarded-For: that is caller-supplied and trivially spoofed.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const salt = `${secret}:${today()}`;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** UTC, matching the boundary Cloudflare's own counters reset on. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
