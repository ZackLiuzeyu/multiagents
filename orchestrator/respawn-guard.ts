/**
 * Serialises respawns per slot. Several paths can decide to respawn the same
 * agent (crash handler, code-0 restart, stale-message watchdog); a respawn
 * can take long enough (Claude waits for its init event) for a second path to
 * fire in between, which would leave two live processes bound to one slot.
 */
export class RespawnGuard {
  private readonly active = new Set<number>();

  inFlight(slotId: number): boolean {
    return this.active.has(slotId);
  }

  /** Run `respawn` unless one is already in flight for the slot (then resolves null). */
  async run<T>(slotId: number, respawn: () => Promise<T>): Promise<T | null> {
    if (this.active.has(slotId)) return null;
    this.active.add(slotId);
    try {
      return await respawn();
    } finally {
      this.active.delete(slotId);
    }
  }
}
