/**
 * The /dev-team usage overlay component. It holds the state machine's state (usage-state.ts), turns
 * keys into transitions, runs this month's load and hands the model to renderUsage (usage-render.ts).
 */
import type { Component } from "@earendil-works/pi-tui";
import { copilotBillingPeriodStart } from "./ai-credits.ts";
import type { SpendRun } from "./session-spend.ts";
import { type MonthSnapshot, monthSnapshot, type UsageBreakdown, usageBreakdown } from "./usage-breakdown.ts";
import type { LoadOptions, SpendHistory } from "./usage-history.ts";
import { renderUsage, type UsageStyle } from "./usage-render.ts";
import { reduce, type Transition, type UsageAction, type UsageEffect, type UsageState, usageKeyFor } from "./usage-state.ts";
import { errorReason } from "./usage-text.ts";

/** The overlay may take this share of the terminal's height; the command passes the same to pi as `maxHeight`. */
export const OVERLAY_HEIGHT_PERCENT = 90;

export interface UsageViewDeps {
	/** This session's runs; read again after `invalidate()`. */
	sessionRuns(): readonly SpendRun[];
	now(): Date;
	/** The terminal's height in rows. */
	terminalRows(): number;
	style: UsageStyle;
	requestRender(): void;
	/** Closes the overlay. */
	close(): void;
	/** Reads this month's spend from the saved sessions; the view cancels it through `signal`. */
	loadHistory(options: Required<Omit<LoadOptions, "root">>): Promise<SpendHistory>;
}

/** The overlay component: owns the state, turns keys into transitions, runs the month's load and renders the model. */
export class UsageView implements Component {
	private readonly deps: UsageViewDeps;
	private state: UsageState;
	private session: UsageBreakdown | undefined;
	private month: MonthSnapshot | undefined;
	/** The load in flight. Whatever else holds a different controller (or none) is a stale load whose news is dropped. */
	private activeLoad: AbortController | undefined;

	constructor(deps: UsageViewDeps, initial: Transition) {
		this.deps = deps;
		this.state = initial.state;
		this.runEffects(initial.effects);
	}

	render(width: number): string[] {
		this.session ??= usageBreakdown(this.deps.sessionRuns());
		const height = Math.max(1, Math.floor((this.deps.terminalRows() * OVERLAY_HEIGHT_PERCENT) / 100));
		return renderUsage({ state: this.state, session: this.session, month: this.month, now: this.deps.now() }, { width, height, style: this.deps.style });
	}

	handleInput(data: string): void {
		const key = usageKeyFor(data);
		if (key) this.dispatch({ type: "key", key });
	}

	invalidate(): void {
		this.session = undefined;
	}

	/** Called by pi when the overlay goes away; a load still running is of no use any more. */
	dispose(): void {
		this.cancelLoad();
	}

	private dispatch(action: UsageAction): void {
		const { state, effects } = reduce(this.state, action);
		this.state = state;
		this.runEffects(effects);
		this.deps.requestRender();
	}

	private runEffects(effects: readonly UsageEffect[]): void {
		for (const effect of effects) {
			if (effect === "start-load") this.startLoad();
			else if (effect === "cancel-load") this.cancelLoad();
			else this.deps.close();
		}
	}

	private startLoad(): void {
		const controller = new AbortController();
		this.activeLoad = controller;
		const isCurrentLoad = () => this.activeLoad === controller;
		const since = copilotBillingPeriodStart(this.deps.now());
		const onProgress = (done: number, total: number) => {
			if (isCurrentLoad()) this.dispatch({ type: "progress", done, total });
		};
		// The snapshot is built inside the async function, so anything it throws is a failed load too.
		(async () => monthSnapshot(await this.deps.loadHistory({ since, signal: controller.signal, onProgress }), this.deps.now()))().then(
			(snapshot) => {
				if (!isCurrentLoad()) return;
				this.activeLoad = undefined;
				this.month = snapshot;
				this.dispatch({ type: "loaded" });
			},
			(err: unknown) => {
				if (!isCurrentLoad()) return;
				this.activeLoad = undefined;
				this.dispatch({ type: "failed", reason: errorReason(err) });
			},
		);
	}

	private cancelLoad(): void {
		this.activeLoad?.abort();
		this.activeLoad = undefined;
	}
}
