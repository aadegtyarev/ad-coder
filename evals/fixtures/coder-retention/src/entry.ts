export interface Entry {
  id: string;
  /** Unix millis when the entry was written. */
  writtenAt: number;
  /** Unix millis of the last read, or undefined when never read. */
  lastReadAt?: number;
  pinned?: boolean;
}

export const DAY = 24 * 60 * 60 * 1000;
