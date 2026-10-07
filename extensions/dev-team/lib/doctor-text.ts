/**
 * The text of `/dev-team doctor`'s model section and of the `/dev-team models` menu it points to, in
 * one place, so the tip always names a menu entry that exists. Model ids come from config a project
 * can set, so they are drawn on one line with escape sequences removed.
 */
import { inherits, type ModelStatus, type PresetAdvice, type TierChange } from "./config.ts";
import { toSingleLine } from "./terminal-text.ts";

/** How doctor shows a ModelStatus. */
export const MODEL_STATUS_TEXT: Record<ModelStatus, string> = { ok: "ok", "no-auth": "NO AUTH (/login)", unknown: "UNKNOWN MODEL" };

/** The `/dev-team models` menu entry for a preset, and how to read the preset back from it. */
const PRESET_MENU_PREFIX = "preset: ";
export const presetMenuLabel = (presetName: string) => `${PRESET_MENU_PREFIX}${presetName}`;
export const presetFromMenuLabel = (label: string) => (label.startsWith(PRESET_MENU_PREFIX) ? label.slice(PRESET_MENU_PREFIX.length) : undefined);
/** The `/dev-team models` menu entry that picks a model per tier, and the name the tip uses for it. */
const CUSTOM_MENU_NAME = "custom";
export const CUSTOM_MENU_LABEL = `${CUSTOM_MENU_NAME}: pick a model per tier`;

const TIP_INDENT = "     ";

/** One tier's entries in the `/dev-team models` custom menu: `value` undefined leaves the tier out of the file. */
export interface TierMenuChoice {
	label: string;
	value: string | undefined;
}

/**
 * The entries for one tier, the file's own setting first so taking the first entry keeps it: the model
 * the file sets, or, when it sets none, an entry that leaves the tier unset (it keeps running on
 * `currentModel`, which another file or the default decides). A file that was not read (the project
 * is not trusted) gets an entry that leaves whatever it sets as it is. Then inherit and the available
 * models. Labels are one line and unique, so a picked label maps back to exactly one value.
 */
export function tierMenuChoices(fileModel: string | undefined, currentModel: unknown, available: readonly string[], fileRead = true): TierMenuChoice[] {
	const own = fileModel === undefined ? undefined : inherits(fileModel) ? "inherit" : fileModel;
	const current = inherits(currentModel) || typeof currentModel !== "string" ? "inherit" : toSingleLine(currentModel);
	const leaveAsIs = fileRead ? `not set in this file (now ${current})` : "keep what this file sets (not read: project not trusted)";
	const first: TierMenuChoice = own === undefined ? { label: leaveAsIs, value: undefined } : { label: `${toSingleLine(own)} (in this file)`, value: own };
	const rest = ["inherit", ...available].filter((m) => m !== own).map((m) => ({ label: toSingleLine(m), value: m }));
	const seen = new Set<string>();
	return [first, ...rest].filter((c) => !seen.has(c.label) && !!seen.add(c.label));
}

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(words: readonly string[]): string {
	return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * One `model tiers:` row. A tier that inherits (as resolveModel reads it: unset, empty or "inherit")
 * shows the session model; a mapped tier shows its model and whether pi can run it.
 */
export function tierLine(tier: string, model: unknown, sessionModel: string | undefined, getModelStatus: (model: string) => ModelStatus): string {
	const name = toSingleLine(tier);
	if (inherits(model)) return `  ${name}: inherit (${sessionModel ? toSingleLine(sessionModel) : "none"})`;
	if (typeof model !== "string") return `  ${name}: (not a model id) ${MODEL_STATUS_TEXT.unknown}`;
	return `  ${name}: ${toSingleLine(model)} ${MODEL_STATUS_TEXT[getModelStatus(model)]}`;
}

const tierModelText = (changes: readonly TierChange[]) => joinWithAnd(changes.map((c) => `${c.tier} to ${c.model}`));

/**
 * The tip lines for doctor's advice: what runs on the session model now, then what to do. When a
 * project config file sets one of the tiers the advice changes (`projectFile`), it wins over a change
 * saved anywhere else, so the tip says to change that file.
 */
export function presetTipLines(advice: PresetAdvice, sessionModel: string, projectFile?: string): string[] {
	const head = `tip: ${joinWithAnd(advice.tiersOnSessionModel)} agents run on ${toSingleLine(sessionModel)}, your session model.`;
	const projectFileLines = projectFile ? [`${TIP_INDENT}${toSingleLine(projectFile)} sets some of these tiers for this project and wins: change them in that file${projectFile.endsWith(".local.json") ? " by hand (/dev-team models does not write it)" : ""}.`] : [];
	if (advice.unusable.length) {
		const models = advice.unusable.map((u) => `${u.model} ${MODEL_STATUS_TEXT[u.status]}`).join(", ");
		return [head, `${TIP_INDENT}preset "${advice.presetName}" needs models this session cannot use: ${models}. Pick a model per tier with /dev-team models → ${CUSTOM_MENU_NAME}.`, ...projectFileLines];
	}
	if (advice.action === "preset") {
		return [head, `${TIP_INDENT}/dev-team models → ${presetMenuLabel(advice.presetName)} sets ${tierModelText(advice.changes)}.`, ...projectFileLines];
	}
	return [
		head,
		`${TIP_INDENT}You mapped other tiers yourself, so set these with /dev-team models → ${CUSTOM_MENU_NAME}: ${tierModelText(advice.changes)}. Leave the other tiers as they are.`,
		...projectFileLines,
	];
}
