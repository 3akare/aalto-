/**
 * Identify a visitor without storing who they are.
 *
 * The ledger needs to tell one visitor from another to enforce "one session at
 * a time", and that is all it needs. Hashing with a salt that rotates daily
 * means the stored value cannot be walked back to an address, and stops being
 * a stable identifier across days even in principle.
 */
export async function hashVisitor(request: Request, secret: string): Promise<string> {
  // CF-Connecting-IP is the real client address. X-Forwarded-For is
  // caller-supplied and trivially spoofed, which would make the cap decorative.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const salt = `${secret}:${today()}`;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** UTC, to match the boundary Cloudflare's own free-plan counters reset on. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
