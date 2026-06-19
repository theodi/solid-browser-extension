// AUTHORED-BY Claude Opus 4.8
/**
 * A single-flight gate: collapse concurrent calls to an idempotent-but-not-safe-to-race
 * async operation into ONE in-flight execution that every caller awaits. Used for the
 * token refresh — a rotation-bound refresh token must be redeemed exactly once, or
 * concurrent grants race (one wins, the others get invalid_grant) and a loser could tear
 * down the freshly-rotated session.
 */
export class SingleFlight<T> {
  #inFlight: Promise<T> | null = null;

  /**
   * Run `op` if nothing is in flight; otherwise return the existing in-flight promise. The
   * slot is released (whether `op` resolves OR rejects) so the next call starts fresh.
   */
  run(op: () => Promise<T>): Promise<T> {
    if (!this.#inFlight) {
      this.#inFlight = op().finally(() => {
        this.#inFlight = null;
      });
    }
    return this.#inFlight;
  }

  /** Whether an operation is currently in flight. */
  get isInFlight(): boolean {
    return this.#inFlight !== null;
  }
}
