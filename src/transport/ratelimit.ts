/** Fixed-window rate limiter, per token id. Single-process; fine for one Termux host. */
export class RateLimiter {
  private readonly perMinute: number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** Returns true if the request may proceed; false = rate limited. */
  allow(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this.buckets.set(key, bucket);
      // Opportunistic cleanup so the map doesn't grow forever
      if (this.buckets.size > 10_000) {
        for (const [k, v] of this.buckets) if (now >= v.resetAt) this.buckets.delete(k);
      }
    }
    bucket.count += 1;
    return bucket.count <= this.perMinute;
  }

  /** Milliseconds until the current window resets for a key (for Retry-After). */
  retryAfterMs(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket ? Math.max(0, bucket.resetAt - Date.now()) : 0;
  }
}
