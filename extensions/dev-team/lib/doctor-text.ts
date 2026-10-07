/**
 * The text of `/dev-team doctor`'s model section and of the `/dev-team models` menu it points to, in
 * one place, so the tip always names a menu entry that exists. Model ids come from config a project
 * can set, so they are drawn on one line with escape sequences removed.
 */
import { inherits, type ModelStatus, type PresetAdvice, type TierModel } from "./config.ts";
import { toSingleLine } from "./terminal-text.ts";

/** How doctor shows a ModelStatus. */
export const MODEL_STATUS_TEXT: Record<ModelStatus, string> = { ok: "ok", "no-auth": "NO AUTH (/login)", unknown: "UNKNOWN MODEL" };

/** The `/dev-team models` menu entry for a preset, and how to read the preset back from it. */
const PRESET_MENU_PREFIX = "preset: ";
export const presetMenuLabel = (preset: string) => `${PRESET_MENU_PREFIX}${preset}`;
export const presetFromMenuLabel = (label: string) => (label.startsWith(PRESET_MENU_PREFIX) ? label.slice(PRESET_MENU_PREFIX.length) : undefined);
/** The `/dev-team models` menu entry that picks a model per tier, and the name the tip uses for it. */
const CUSTOM_MENU_NAME = "custom";
export const CUSTOM_MENU_LABEL = `${CUSTOM_MENU_NAME}: pick a model per tier`;

const TIP_INDENT = "     ";

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(words: readonly string[]): string {
	return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * One `model tiers:` row. A tier that inherits (as resolveModel reads it: unset, empty or "inherit")
 * shows the session model; a mapped tier shows its model and whether pi can run it.
 */
export function tierLine(tier: string, model: unknown, sessionModel: string | undefined, getStatus: (model: string) => ModelStatus): string {
	const name = toSingleLine(tier);
	if (inherits(model)) return `  ${name}: inherit (${sessionModel ? toSingleLine(sessionModel) : "none"})`;
	if (typeof model !== "string") return `  ${name}: ${toSingleLine(String(model))} ${MODEL_STATUS_TEXT.unknown}`;
	return `  ${name}: ${toSingleLine(model)} ${MODEL_STATUS_TEXT[getStatus(model)]}`;
}

const tierModelText = (changes: readonly TierModel[]) => joinWithAnd(changes.map((c) => `${c.tier} to ${c.model}`));

/**
 * The tip lines for doctor's advice: what runs on the session model now, then what to do. When the
 * project's own config sets tiers (`projectFiles`), a change saved for the user would not apply here,
 * so the tip says where to save it.
 */
export function presetTipLines(advice: PresetAdvice, sessionModel: string, projectFiles: readonly string[] = []): string[] {
	const head = `tip: ${joinWithAnd(advice.tiersOnSessionModel)} agents run on ${toSingleLine(sessionModel)}, your session model.`;
	const scope = projectFiles.length ? [`${TIP_INDENT}${projectFiles.map(toSingleLine).join(" and ")} sets tiers for this project: save it for the project.`] : [];
	if (advice.unusable.length) {
		const models = advice.unusable.map((u) => `${u.model} ${MODEL_STATUS_TEXT[u.status]}`).join(", ");
		return [head, `${TIP_INDENT}preset "${advice.preset}" needs models this session cannot use: ${models}. Pick a model per tier with /dev-team models → ${CUSTOM_MENU_NAME}.`, ...scope];
	}
	if (advice.action === "preset") {
		return [head, `${TIP_INDENT}/dev-team models → ${presetMenuLabel(advice.preset)} sets ${tierModelText(advice.changes)}.`, ...scope];
	}
	return [
		head,
		`${TIP_INDENT}You mapped other tiers yourself, so set these with /dev-team models → ${CUSTOM_MENU_NAME}: ${tierModelText(advice.changes)}. Keep the current model for the other tiers.`,
		...scope,
	];
}
