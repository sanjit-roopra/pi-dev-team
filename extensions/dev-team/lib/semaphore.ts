/**
 * The slot limiter behind maxParallelAgents. Waiters are told their place in line (1 = next) when
 * they join and each time the line moves, so the progress view can show it.
 */

/** A waiter for a slot. */
interface Waiter {
	start: () => void;
	onPosition?: (position: number) => void;
}

/** A position callback must not stop the line: a throw there is dropped. */
function tell(onPosition: ((position: number) => void) | undefined, position: number): void {
	try {
		onPosition?.(position);
	} catch {
		/* the line moves on regardless */
	}
}

export class Semaphore {
	private active = 0;
	private readonly queue: Waiter[] = [];
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async acquire(onPosition?: (position: number) => void): Promise<() => void> {
		if (this.active >= this.limit) {
			await new Promise<void>((start) => {
				this.queue.push({ start, onPosition });
				tell(onPosition, this.queue.length);
			});
		}
		this.active++;
		return () => {
			this.active--;
			// Hand the slot on first, so nothing a waiter is told can keep the next one waiting.
			this.queue.shift()?.start();
			this.queue.forEach((w, i) => tell(w.onPosition, i + 1));
		};
	}
}

/**
 * Wait for a slot while `update` reports the place in line, then report the start: the place is
 * cleared and `startedAt` set. Returns the slot's release.
 */
export async function acquireSlot(
	semaphore: Semaphore,
	update: (patch: { queuePosition?: number; startedAt?: number }) => void,
	now: () => number = Date.now,
): Promise<() => void> {
	const release = await semaphore.acquire((position) => update({ queuePosition: position }));
	update({ queuePosition: undefined, startedAt: now() });
	return release;
}
