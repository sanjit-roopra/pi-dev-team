/**
 * The slot limiter behind maxParallelAgents. A waiter is told its place in line (1 = next) when it
 * joins and each time the line moves.
 */

/** A waiter for a slot. */
interface Waiter {
	grantSlot: () => void;
	onPosition?: (position: number) => void;
}

/** A position callback must not stop the line: a throw there is dropped. */
function notifyPosition(onPosition: ((position: number) => void) | undefined, position: number): void {
	try {
		onPosition?.(position);
	} catch {
		/* the line moves on regardless */
	}
}

export class Semaphore {
	private active = 0;
	private readonly queue: Waiter[] = [];
	/**
	 * Changeable at any time; the next acquire or release applies it. Callers pass a checked value
	 * (subagent.ts parallelLimit); as a safety net, a limit that is not a finite number of at least 1 counts as 1.
	 */
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async acquire(onPosition?: (position: number) => void): Promise<() => void> {
		this.grantFreeSlots();
		if (this.active < this.effectiveLimit()) this.active++;
		else
			await new Promise<void>((grantSlot) => {
				this.queue.push({ grantSlot, onPosition });
				notifyPosition(onPosition, this.queue.length);
			});
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.grantFreeSlots();
		};
	}
	/** The limit in effect: a slot always exists, so a bad limit can slow the line but never stop it. */
	private effectiveLimit(): number {
		return Number.isFinite(this.limit) && this.limit >= 1 ? this.limit : 1;
	}
	/**
	 * Give each free slot to the next waiter. The slot is counted when it is granted, not when the
	 * waiter resumes, so an acquire in between cannot take it too. Then the rest of the line moves up.
	 */
	private grantFreeSlots(): void {
		let granted = false;
		while (this.active < this.effectiveLimit() && this.queue.length) {
			this.active++;
			this.queue.shift()?.grantSlot();
			granted = true;
		}
		if (granted) this.queue.forEach((w, i) => notifyPosition(w.onPosition, i + 1));
	}
}
