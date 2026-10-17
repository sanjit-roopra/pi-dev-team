/**
 * Keeps the pi-subagents package (npm:pi-subagents) out of dev-team sessions. Its loader tool
 * advertises itself for "specialist, independent-review, or parallel work", which is the wording of
 * dev-team's own review steps, so a model following /code-review called subagents_enable and then
 * dispatched outside dev_team_subagent: no tier mapping, no dispatch hooks, no review evidence for the
 * PR gate. dev-team blocks those tools in tool_call (the guarantee) and hides them from the model at
 * session start and at the start of every run (so the model is not tempted in the first place).
 * Nothing is blocked when pi-subagents is not installed.
 * `allowPiSubagents: true` in the user's dev-team.json turns both off.
 */
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";

/** pi-subagents' loader: a name no other package uses, so it is blocked even if pi reports no source for it. */
const LOADER_TOOL = "subagents_enable";
/**
 * Left active. bg_wait: pi-subagents treats a run that drops it as its extension being unloaded and
 * puts its tools back at the next session start (tool-activation.js). contact_supervisor: a child
 * started by pi-subagents uses it to reach its parent. Neither can start work.
 */
const KEPT_TOOLS = new Set(["bg_wait", "contact_supervisor"]);
/**
 * The package source pi records for a package entry in settings: npm:pi-subagents, a git URL or a
 * local path ending in pi-subagents, each with an optional @version. Matched on the source, not the
 * file path, so a project checked out under a directory named pi-subagents is not caught.
 */
const PACKAGE_SOURCE = /(^|[:/\\])pi-subagents(@[\w.+-]+)?[/\\]?$/;
/** System prompt sections pi-subagents adds for its agent catalog and its background runs. */
const PROMPT_SECTIONS = ["advertised_subagents", "active_subagents"];

interface SourceInfoLike {
	source?: string;
	origin?: string;
}

interface ToolSource {
	name: string;
	sourceInfo?: SourceInfoLike;
}

export const fromPiSubagents = (info: SourceInfoLike | undefined) => info?.origin === "package" && PACKAGE_SOURCE.test(info.source ?? "");

/** The tools to keep from the model: every tool pi-subagents registers, except KEPT_TOOLS. Empty when it is not installed. */
export function piSubagentsTools(all: readonly ToolSource[]): Set<string> {
	const names = new Set<string>();
	for (const tool of all) if (tool.name === LOADER_TOOL || fromPiSubagents(tool.sourceInfo)) names.add(tool.name);
	for (const name of KEPT_TOOLS) names.delete(name);
	return names;
}

/**
 * True when pi-subagents is listed after dev-team in pi's packages: pi runs extensions in that order
 * (and getAllTools lists their tools in it), so pi-subagents' handlers would put its loader back into
 * the prompt after dev-team removed it. The tool_call block still holds; the user is told to reorder.
 */
export function piSubagentsLoadsLater(all: readonly ToolSource[], ownTool: string): boolean {
	const own = all.findIndex((tool) => tool.name === ownTool);
	return own >= 0 && all.some((tool, i) => i > own && fromPiSubagents(tool.sourceInfo));
}

/** What a blocked call returns to the model. */
export function piSubagentsBlockReason(toolName: string): string {
	return (
		`${toolName} belongs to pi-subagents, which this dev-team session does not use. ` +
		`Dispatch agents with ${DEV_TEAM_SUBAGENT_TOOL} (agent=<name>, task=<full prompt>): only it applies the dev-team tier models, ` +
		"the dispatch hooks and the review evidence the PR gate checks. For independent or parallel reviews, issue several " +
		`${DEV_TEAM_SUBAGENT_TOOL} calls in one message.`
	);
}

/** `active` without the blocked tools, or undefined when none of them is active. */
export function withoutBlocked(active: readonly string[], blocked: ReadonlySet<string>): string[] | undefined {
	return active.some((name) => blocked.has(name)) ? active.filter((name) => !blocked.has(name)) : undefined;
}

/**
 * Removes pi-subagents from this run's system prompt: its tools from the selection (it adds its loader
 * there directly, and an explicit selection wins over the active tools), their snippets and guidelines,
 * its prompt sections and its skills.
 */
export function stripPiSubagentsPrompt(opts: BuildSystemPromptOptions, blocked: ReadonlySet<string>): void {
	if (!blocked.size) return;
	if (opts.selectedTools) {
		const kept = withoutBlocked(opts.selectedTools, blocked);
		if (kept) opts.selectedTools = kept;
	}
	for (const name of blocked) {
		if (opts.toolSnippets) delete opts.toolSnippets[name];
		if (opts.toolGuidelines) delete opts.toolGuidelines[name];
	}
	if (opts.sections) for (const key of PROMPT_SECTIONS) delete opts.sections[key];
	if (opts.skills) opts.skills = opts.skills.filter((skill) => !fromPiSubagents(skill.sourceInfo));
}
