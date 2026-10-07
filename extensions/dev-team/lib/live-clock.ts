/**
 * The once-a-second redraw of a running dispatch row, so its clocks move while no agent reports
 * anything. It lives in pi's per-row renderer state (`context.state`, with `context.invalidate` to
 * redraw), as pi's own bash renderer keeps its timer, and stops on the final result.
 */
import type { ToolRenderContext } from "@earendil-works/pi-coding-agent";

export const CLOCK_TICK_MS = 1000;
/** With no update for this long the clock stops (its run is gone); the next update starts it again. */
export const CLOCK_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;

/** What the clock keeps in `context.state`; prefixed, since the row's state is shared with pi. */
interface ClockState {
	devTeamClock?: ReturnType<typeof setInterval>;
	devTeamLastDetails?: unknown;
	devTeamLastUpdateAt?: number;
}

/**
 * Start the clock while `isRunning`, stop it otherwise. A new `details` object is a new update (each
 * progress snapshot is a fresh object; a redraw passes the same one). A redraw that throws stops it.
 */
export function syncClock(context: Pick<ToolRenderContext, "invalidate" | "state"> | undefined, details: unknown, isRunning: boolean, now: number): void {
	const state = context?.state as ClockState | undefined;
	if (!context || !state || typeof state !== "object") return;
	if (state.devTeamLastDetails !== details) {
		state.devTeamLastDetails = details;
		state.devTeamLastUpdateAt = now;
	}
	const stop = () => {
		clearInterval(state.devTeamClock);
		state.devTeamClock = undefined;
	};
	if (!isRunning) return stop();
	if (state.devTeamClock) return;
	state.devTeamClock = setInterval(() => {
		if (Date.now() - (state.devTeamLastUpdateAt ?? 0) > CLOCK_IDLE_LIMIT_MS) return stop();
		try {
			context.invalidate();
		} catch {
			stop();
		}
	}, CLOCK_TICK_MS);
	state.devTeamClock.unref?.();
}
