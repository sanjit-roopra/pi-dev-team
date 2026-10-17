/**
 * Stops an assistant message whose tool-call arguments keep streaming. pi runs a tool only once its
 * arguments are complete, and a provider stream has no size limit, so a model that degenerates inside
 * an argument (seen with a dev_team_subagent task: megabytes of text and no tool ever started) leaves
 * the session showing one frozen row until the model's output limit or Esc. The watchdog counts the
 * argument text of each tool call in the message being streamed and reports the first one over its
 * limit; the extension then aborts the run and tells the user.
 */
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";

/** Characters of arguments a dispatch may stream: far above a real task prompt, or several in tasks[]. */
export const DISPATCH_ARGS_LIMIT = 256_000;
/** Characters of arguments any other tool may stream; high enough for a large file passed to write. */
export const TOOL_ARGS_LIMIT = 4_000_000;

export interface RunawayToolCall {
	toolName: string;
	chars: number;
	limit: number;
}

export const argsLimitFor = (toolName: string) => (toolName === DEV_TEAM_SUBAGENT_TOOL ? DISPATCH_ARGS_LIMIT : TOOL_ARGS_LIMIT);

export class ToolArgsWatchdog {
	private chars = new Map<number, number>();
	private tripped = false;

	/** A new message starts: counts begin again. */
	reset(): void {
		this.chars.clear();
		this.tripped = false;
	}

	/** Adds one argument delta of the tool call at `contentIndex`; returns the call the first time it passes its limit. */
	add(contentIndex: number, delta: string, toolName: string): RunawayToolCall | undefined {
		if (this.tripped) return undefined;
		const chars = (this.chars.get(contentIndex) ?? 0) + delta.length;
		this.chars.set(contentIndex, chars);
		const limit = argsLimitFor(toolName);
		if (chars <= limit) return undefined;
		this.tripped = true;
		return { toolName, chars, limit };
	}
}

/** What the user is told when the watchdog stops a run. */
export function describeRunaway({ toolName, chars, limit }: RunawayToolCall): string {
	const k = (n: number) => `${Math.round(n / 1000)}k`;
	return (
		`dev-team: stopped the model — its ${toolName || "tool"} call streamed ${k(chars)} characters of arguments ` +
		`(limit ${k(limit)}) without finishing, so the tool could never start. Send your request again.`
	);
}
