/**
 * The demo budget ledger - what stands between a public voice demo and an empty
 * pot of credit.
 *
 * A Durable Object rather than KV because the decision is read-modify-write:
 * KV's eventually-consistent reads let two visitors arriving at once both see
 * budget remaining and both spend it. SQLite-backed, the flavour on the free plan.
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
const LEASE_SLACK_MS = 10_000;

/**
 * Not one: a visitor is an address, and judges sit behind shared ones, where a
 * strict lock means the second person to try is told someone else is using it.
 * Two stops tab-spam; the daily cap is what actually bounds spend.
 */
const MAX_CONCURRENT_PER_VISITOR = 2;

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
        issued_at  INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL
      );
    `);
    try {
      // For ledgers created before issued_at existed; throws once it is there.
      this.sql.exec("ALTER TABLE leases ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Already migrated.
    }
  }

  /** Take out a lease, charging the full session length up front. */
  mint(visitor: string, day: string, seconds: number, dailyCap: number): MintResult {
    this.sweep();

    const active = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM leases WHERE visitor = ?", visitor)
      .one().n;
    if (active >= MAX_CONCURRENT_PER_VISITOR) return { ok: false, reason: "active_session" };

    const granted = this.grantedToday(day);
    if (granted + seconds > dailyCap) return { ok: false, reason: "daily_limit" };

    const leaseId = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO leases (lease_id, visitor, granted, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      leaseId,
      visitor,
      seconds,
      now,
      now + seconds * 1000 + LEASE_SLACK_MS
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

  /**
   * Free the slot. Deliberately does NOT refund.
   *
   * Minting is the irreversible act - the token is good for its full length
   * from the moment it is issued and nothing here can revoke it. So any refund
   * the client can reach is a way to mint unlimited sessions against a cap that
   * never moves: release the lease, open the socket anyway, and AssemblyAI
   * bills a session the ledger thinks was free.
   */
  release(leaseId: string): void {
    this.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
  }

  /**
   * Undo a grant for a session that was never issued. Only reachable when the
   * upstream mint failed - something the Worker knows and the client cannot
   * claim. Without it an outage would eat the day's budget one request at a time.
   */
  cancel(leaseId: string, day: string): void {
    const lease = this.sql
      .exec<{ granted: number }>("SELECT granted FROM leases WHERE lease_id = ?", leaseId)
      .toArray()[0];
    if (!lease) return;

    this.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
    this.sql.exec(
      "UPDATE budget SET seconds_granted = MAX(0, seconds_granted - ?) WHERE day = ?",
      lease.granted,
      day
    );
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

  /** Drop leases nobody came back to release. The grant stays spent: guessing
   *  in the visitor's favour is how a cap gets talked past. */
  private sweep(): void {
    this.sql.exec("DELETE FROM leases WHERE expires_at < ?", Date.now());
  }
}
