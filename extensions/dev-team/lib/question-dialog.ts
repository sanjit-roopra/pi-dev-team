/**
 * The dialogs that ask the human: a pick from options, or a typed answer. Each shows whether it
 * waits for the human or goes on alone after a time ("⏱ 1:47 left · w = wait" or "⏸ waiting for
 * you"). In pi's TUI the pick is a custom component, because pi's own select cannot take an extra
 * key: `w` stops the timer, and the human keeps it stopped for the rest of the questions (`Waiter`).
 * Other modes (rpc) use pi's select with its timeout.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Shared by the questions of one ask: once the human presses `w`, no later question times out. */
export interface Waiter {
	waiting: boolean;
	/** Set when a question's time ran out (not when the human skipped it). */
	timedOut?: boolean;
}

/** pi's own dialogs return undefined both for a timeout and for Esc; the time spent tells them apart. */
async function timed(req: { timeoutMs?: number; waiter: Waiter }, timeoutMs: number | undefined, ask: () => Promise<string | undefined>): Promise<string | undefined> {
	const started = performance.now();
	const answer = await ask();
	if (answer === undefined && timeoutMs !== undefined && performance.now() - started >= timeoutMs - 250) req.waiter.timedOut = true;
	return answer;
}

/** Seconds as m:ss. */
export function clock(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The line that says whether this question waits for the human. `canWait`: the `w` key works here. */
export function modeLine(secondsLeft: number | undefined, canWait = true): string {
	if (secondsLeft === undefined) return "⏸ waiting for you";
	return `⏱ ${clock(secondsLeft)} left${canWait ? " · w = wait" : ""}`;
}

export interface PickRequest {
	title: string;
	/** Lines under the title, such as the "why it matters" line. */
	body: string[];
	options: string[];
	/** No timeout: wait for the human. */
	timeoutMs?: number;
	signal?: AbortSignal;
	waiter: Waiter;
}

const HINT = "↑↓ move · enter pick · esc skip";

/** The option the human picked, or undefined when the time ran out, they skipped, or the call was aborted. */
export async function pickOne(ctx: ExtensionContext, req: PickRequest): Promise<string | undefined> {
	const timeoutMs = req.waiter.waiting ? undefined : req.timeoutMs;
	if (ctx.mode !== "tui") {
		const title = [req.title, ...req.body, modeLine(timeoutMs === undefined ? undefined : timeoutMs / 1000, false)].join("\n");
		return timed(req, timeoutMs, () => ctx.ui.select(title, req.options, { signal: req.signal, timeout: timeoutMs }));
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let selected = 0;
		let secondsLeft = timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1000);
		let timer: ReturnType<typeof setInterval> | undefined;
		const stop = () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		};
		const finish = (answer: string | undefined) => {
			stop();
			req.signal?.removeEventListener("abort", onAbort);
			done(answer);
		};
		const onAbort = () => finish(undefined);
		if (req.signal?.aborted) queueMicrotask(onAbort);
		else req.signal?.addEventListener("abort", onAbort, { once: true });
		if (secondsLeft !== undefined) {
			timer = setInterval(() => {
				secondsLeft = (secondsLeft ?? 0) - 1;
				if (secondsLeft > 0) return tui.requestRender();
				req.waiter.timedOut = true;
				finish(undefined);
			}, 1000);
		}
		return {
			render(width: number): string[] {
				const w = Math.max(1, width);
				const lines = [
					...wrapTextWithAnsi(theme.fg("accent", theme.bold(req.title)), w),
					...req.body.flatMap((line) => wrapTextWithAnsi(theme.fg("muted", line), w)),
					"",
					...req.options.flatMap((option, i) =>
						wrapTextWithAnsi(i === selected ? theme.fg("accent", `→ ${option}`) : `  ${option}`, w),
					),
					"",
					theme.fg(secondsLeft === undefined ? "accent" : "warning", modeLine(secondsLeft)),
					theme.fg("dim", HINT),
				];
				return lines.map((line) => truncateToWidth(line, w));
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
				else if (matchesKey(data, Key.down)) selected = Math.min(req.options.length - 1, selected + 1);
				else if (matchesKey(data, Key.enter)) return finish(req.options[selected]);
				else if (matchesKey(data, Key.escape)) return finish(undefined);
				else if (data === "w" && secondsLeft !== undefined) {
					stop();
					secondsLeft = undefined;
					req.waiter.waiting = true;
				}
				tui.requestRender();
			},
			invalidate() {},
			dispose: stop,
		};
	});
}

/** A typed answer. pi's input shows its own countdown; `w` cannot work while the human types. */
export async function typeAnswer(
	ctx: ExtensionContext,
	req: Omit<PickRequest, "options">,
): Promise<string | undefined> {
	const timeoutMs = req.waiter.waiting ? undefined : req.timeoutMs;
	const title = [req.title, ...req.body, modeLine(timeoutMs === undefined ? undefined : timeoutMs / 1000, false)].join("\n");
	return timed(req, timeoutMs, () => ctx.ui.input(title, undefined, { signal: req.signal, timeout: timeoutMs }));
}
