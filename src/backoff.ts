/**
 * Per-key exponential backoff for HTTP 429 responses.
 *
 * Pure and clock-injectable so the strike/clear/expiry behaviour can be unit
 * tested without waiting on real time.
 */

export interface BackoffOptions {
	/** Delay after the first strike. Defaults to 10 minutes. */
	readonly baseMs?: number;
	/** Upper bound for the delay. Defaults to 60 minutes. */
	readonly maxMs?: number;
	readonly now?: () => number;
}

export class Backoff {
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly now: () => number;
	private readonly strikes = new Map<string, number>();
	private readonly blockedUntil = new Map<string, number>();

	constructor(options: BackoffOptions = {}) {
		this.baseMs = Math.max(0, options.baseMs ?? 10 * 60_000);
		this.maxMs = Math.max(this.baseMs, options.maxMs ?? 60 * 60_000);
		this.now = options.now ?? Date.now;
	}

	/** Records a rate-limit hit and returns the applied delay in ms. */
	strike(key: string): number {
		const strikes = (this.strikes.get(key) ?? 0) + 1;
		this.strikes.set(key, strikes);
		const exponent = Math.min(strikes - 1, 16); // guard 2**n overflow
		const delay = Math.min(this.baseMs * 2 ** exponent, this.maxMs);
		this.blockedUntil.set(key, this.now() + delay);
		return delay;
	}

	/** Clears the backoff after a success. */
	clear(key: string): void {
		this.strikes.delete(key);
		this.blockedUntil.delete(key);
	}

	/** Milliseconds until the key may be queried again; 0 when it is allowed now. */
	remaining(key: string): number {
		const until = this.blockedUntil.get(key) ?? 0;
		return Math.max(0, until - this.now());
	}

	/** ISO timestamp of the current backoff expiry, for display. */
	retryAt(key: string): string | undefined {
		const remaining = this.remaining(key);
		if (remaining <= 0) return undefined;
		return new Date(this.now() + remaining).toISOString();
	}
}
