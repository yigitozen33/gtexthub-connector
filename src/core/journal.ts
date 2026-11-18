/**
 * Journal of the device requests this connector has taken on, keyed by the
 * request id. It is the de-duplication set (a request is handled once even if
 * the queue lists it again) and, when persisted, makes sending at-most-once
 * across restarts: a hand-off is marked started BEFORE Discord is called, so a
 * crash mid-send never re-sends; a finished result whose report did not reach
 * the platform is re-reported on the next start.
 */

export interface JournalResult {
  outcome: 'sent' | 'failed';
  reason: string | null;
  tokenRejected: boolean;
  /** The device holds no token for the account (reported as `tokenMissing: true`). */
  tokenMissing?: boolean;
}

export interface JournalEntry {
  id: string;
  kind: 'handOff' | 'guildChannels';
  startedAt: number;
  /** handOff only: the finished result, kept until it is reported. */
  result?: JournalResult;
  reported: boolean;
}

export interface JournalPersistence {
  read(): JournalEntry[] | null;
  write(entries: JournalEntry[]): void;
}

/** Entries are kept 30 minutes; the platform lists requests only for 5. */
export const JOURNAL_TTL_MS = 30 * 60_000;

export class RequestJournal {
  private entries = new Map<string, JournalEntry>();

  constructor(
    private readonly persistence: JournalPersistence | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {
    const loaded = persistence?.read() ?? [];
    for (const e of loaded) {
      if (e && typeof e.id === 'string' && typeof e.startedAt === 'number') this.entries.set(e.id, e);
    }
    this.prune();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  start(id: string, kind: JournalEntry['kind']): void {
    this.entries.set(id, { id, kind, startedAt: this.now(), reported: false });
    this.flush();
  }

  setResult(id: string, result: JournalResult): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.result = result;
    this.flush();
  }

  markReported(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.reported) return;
    e.reported = true;
    this.flush();
  }

  /** Finished hand-offs whose result has not reached the platform yet. */
  unreported(): JournalEntry[] {
    return [...this.entries.values()].filter((e) => e.kind === 'handOff' && e.result && !e.reported);
  }

  prune(): void {
    const cutoff = this.now() - JOURNAL_TTL_MS;
    let changed = false;
    for (const [id, e] of this.entries) {
      if (e.startedAt < cutoff) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  clear(): void {
    this.entries.clear();
    this.flush();
  }

  size(): number {
    return this.entries.size;
  }

  private flush(): void {
    this.persistence?.write([...this.entries.values()]);
  }
}
