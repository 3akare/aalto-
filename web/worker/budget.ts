/**
 * The demo budget ledger.
 *
 * A public voice demo is an open tap on a metered API, and the meter is a fixed
 * pot of hackathon credit. This object is the thing standing between a judge
 * opening the page and that pot being empty by lunchtime.
 *
 * A Durable Object rather than KV because the decision is read-modify-write:
 * KV's eventually-consistent reads let two visitors arriving at once both see
 * budget remaining and both spend it, which is precisely the case the cap
 * exists for. SQLite-backed, because that is the flavour available on the free
 * plan.
 */

import { DurableObject } from "cloudflare:workers";

export interface MintResult {
  ok: boolean;
  reason?: "active_session" | "daily_limit";
  leaseId?: string;
  seconds?: number;
}

export interface BudgetStatus {
  remainingSeconds: number;
  dailyCapSeconds: number;
  activeSessions: number;
}

/** Grace on top of the session cap before a lease is assumed spent and swept. */
const LEASE_SLACK_MS = 30_000;

export class DemoBudget extends DurableObject {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, seconds_granted INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (
        lease_id   TEXT PRIMARY KEY,
        visitor    TEXT NOT NULL,
        granted    INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Take out a lease, charging the worst case up front.
   *
   * Deducting the full session length at mint and refunding the unused part on
   * release is the only arrangement that survives the common case: someone
   * opens the demo, says two sentences, and shuts the laptop. Charging on
   * release alone would let that leak the whole cap; charging up front means
   * the worst they cost is what they were granted.
   */
  mint(visitor: string, day: string, seconds: number, dailyCap: number): MintResult {
    this.sweep();

    const active = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM leases WHERE visitor = ?", visitor)
      .one().n;
    if (active > 0) return { ok: false, reason: "active_session" };

    const granted = this.grantedToday(day);
    if (granted + seconds > dailyCap) return { ok: false, reason: "daily_limit" };

    const leaseId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO leases (lease_id, visitor, granted, expires_at) VALUES (?, ?, ?, ?)",
      leaseId,
      visitor,
      seconds,
      Date.now() + seconds * 1000 + LEASE_SLACK_MS
    );
    this.sql.exec(
      `INSERT INTO budget (day, seconds_granted) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET seconds_granted = seconds_granted + ?`,
      day,
      seconds,
      seconds
    );
    return { ok: true, leaseId, seconds };
  }

  /** Hand back what was granted but not used. Best effort: the client reports it. */
  release(leaseId: string, day: string, usedSeconds: number): void {
    const lease = this.sql
      .exec<{ granted: number }>("SELECT granted FROM leases WHERE lease_id = ?", leaseId)
      .toArray()[0];
    if (!lease) return; // already swept, or never existed; either way nothing to refund

    const refund = Math.max(0, lease.granted - Math.min(usedSeconds, lease.granted));
    this.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
    if (refund > 0) {
      this.sql.exec(
        "UPDATE budget SET seconds_granted = MAX(0, seconds_granted - ?) WHERE day = ?",
        refund,
        day
      );
    }
  }

  status(day: string, dailyCap: number): BudgetStatus {
    this.sweep();
    return {
      remainingSeconds: Math.max(0, dailyCap - this.grantedToday(day)),
      dailyCapSeconds: dailyCap,
      activeSessions: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM leases").one().n,
    };
  }

  private grantedToday(day: string): number {
    const row = this.sql
      .exec<{ seconds_granted: number }>("SELECT seconds_granted FROM budget WHERE day = ?", day)
      .toArray()[0];
    return row?.seconds_granted ?? 0;
  }

  /**
   * Drop leases nobody came back to release.
   *
   * Expired without a release means the tab was closed mid-session, so the
   * grant stays spent - guessing in the visitor's favour here is exactly how
   * the cap gets talked past.
   */
  private sweep(): void {
    this.sql.exec("DELETE FROM leases WHERE expires_at < ?", Date.now());
  }
}
