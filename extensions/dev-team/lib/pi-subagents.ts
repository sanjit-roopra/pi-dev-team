/**
 * Keeps the pi-subagents package (npm:pi-subagents) out of dev-team sessions. Its loader tool
 * advertises itself for "specialist, independent-review, or parallel work", which is the wording of
 * dev-team's own review steps, so a model following /code-review called subagents_enable and then
 * dispatched outside dev_team_subagent: no tier mapping, no dispatch hooks, no review evidence for the
 * PR gate. dev-team blocks those tools in tool_call (the guarantee) and hides them from the model at
 * session start and at the start of every run (so the model is not tempted in the first place).
 * `allowPiSubagents: true` in the user's dev-team.json turns both off.
 */
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";

/** pi-subagents' delegation tools, by the names it registers them under. */
const PI_SUBAGENTS_TOOLS = ["subagents_enable", "subagent", "contact_supervisor"];
/**
 * Left active: pi-subagents treats a run that drops bg_wait as its extension being unloaded and puts
 * its tools back at the next session start (tool-activation.js), and bg_wait alone cannot start work.
 */
const KEPT_TOOLS = new Set(["bg_wait"]);
/** A path inside the package, however it was installed: npm, git or a local checkout. */
const PACKAGE_PATH = /[\\/]pi-subagents[\\/]/;
/** System prompt sections pi-subagents adds for its agent catalog and its background runs. */
const PROMPT_SECTIONS = ["advertised_subagents", "active_subagents"];

interface ToolSource {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

const fromPackage = (info: ToolSource["sourceInfo"]) =>
	PACKAGE_PATH.test(info?.path ?? "") || /(^|[:/])pi-subagents$/.test(info?.source ?? "");

/** The tools to keep from the model: pi-subagents' delegation tools, plus any other tool the package registers, except bg_wait. */
export function piSubagentsTools(all: readonly ToolSource[]): Set<string> {
	const names = new Set(PI_SUBAGENTS_TOOLS);
	for (const tool of all) if (fromPackage(tool.sourceInfo)) names.add(tool.name);
	for (const name of KEPT_TOOLS) names.delete(name);
	return names;
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
	if (opts.selectedTools) {
		const kept = withoutBlocked(opts.selectedTools, blocked);
		if (kept) opts.selectedTools = kept;
	}
	for (const name of blocked) {
		if (opts.toolSnippets) delete opts.toolSnippets[name];
		if (opts.toolGuidelines) delete opts.toolGuidelines[name];
	}
	if (opts.sections) for (const key of PROMPT_SECTIONS) delete opts.sections[key];
	if (opts.skills) opts.skills = opts.skills.filter((skill) => !PACKAGE_PATH.test(skill.filePath));
}
