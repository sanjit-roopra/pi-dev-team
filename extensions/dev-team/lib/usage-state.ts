/**
 * The state machine behind the /dev-team usage overlay: which scope and view are shown and how the
 * this-month load is going. Pure: `reduce` maps a state and an action (a key, or news from the load)
 * to the next state plus the effects the view must carry out (start or cancel the load, close), so
 * every rule is testable without pi or a terminal. Mapping raw terminal input to a UsageKey and
 * parsing the command's arguments live here too, as they are the other two inputs to the machine.
 */
import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export type Scope = "session" | "month";
export type View = "model" | "agent";

/**
 * The this-month history load. It outlives the scope: "ready" is kept when the user goes back to this
 * session, so pressing `s` again shows the loaded month at once. A cancelled or failed load is "idle"
 * again, so `s` restarts it. In this-session scope the load is therefore only ever idle or ready.
 */
export type LoadState =
	| { kind: "idle" }
	| { kind: "loading"; progress?: { done: number; total: number } }
	| { kind: "ready" }
	| { kind: "error"; reason: string };

export interface UsageState {
	scope: Scope;
	view: View;
	load: LoadState;
}

/** What a key press means, independent of which key produced it. */
export type UsageKey = "next-view" | "previous-view" | "toggle-scope" | "close";

export type UsageAction =
	| { type: "key"; key: UsageKey }
	| { type: "progress"; done: number; total: number }
	| { type: "loaded" }
	| { type: "failed"; reason: string };

/** What the view must do besides re-render. */
export type UsageEffect = "start-load" | "cancel-load" | "close";

export interface Transition {
	state: UsageState;
	effects: UsageEffect[];
}

/** Left to right as Tab walks them. */
const VIEWS: readonly View[] = ["model", "agent"];

const LOADING: LoadState = { kind: "loading" };
const IDLE: LoadState = { kind: "idle" };

/** The state a freshly opened overlay starts in: By model, with the month's load started when it opens on the month. */
export function openUsage(scope: Scope): Transition {
	if (scope === "month") return { state: { scope, view: "model", load: LOADING }, effects: ["start-load"] };
	return { state: { scope, view: "model", load: IDLE }, effects: [] };
}

function stepView(state: UsageState, step: number): Transition {
	const next = VIEWS[(VIEWS.indexOf(state.view) + step + VIEWS.length) % VIEWS.length];
	return { state: { ...state, view: next }, effects: [] };
}

/** `s`: this session to this month (loading it unless already loaded), and back (cancelling a load still running). */
function toggleScope(state: UsageState): Transition {
	if (state.scope === "session") {
		if (state.load.kind === "ready") return { state: { ...state, scope: "month" }, effects: [] };
		return { state: { ...state, scope: "month", load: LOADING }, effects: ["start-load"] };
	}
	const cancelling = state.load.kind === "loading";
	const load = state.load.kind === "ready" ? state.load : IDLE;
	return { state: { ...state, scope: "session", load }, effects: cancelling ? ["cancel-load"] : [] };
}

function pressKey(state: UsageState, key: UsageKey): Transition {
	switch (key) {
		case "next-view":
			return stepView(state, 1);
		case "previous-view":
			return stepView(state, -1);
		case "toggle-scope":
			return toggleScope(state);
		case "close":
			return { state, effects: state.load.kind === "loading" ? ["cancel-load", "close"] : ["close"] };
	}
}

/** News about the load only counts while one is running: a late event from a cancelled load is dropped. */
function loadEvent(state: UsageState, action: Exclude<UsageAction, { type: "key" }>): Transition {
	if (state.load.kind !== "loading") return { state, effects: [] };
	switch (action.type) {
		case "progress":
			return { state: { ...state, load: { kind: "loading", progress: { done: action.done, total: action.total } } }, effects: [] };
		case "loaded":
			return { state: { ...state, load: { kind: "ready" } }, effects: [] };
		case "failed":
			return { state: { ...state, load: { kind: "error", reason: action.reason } }, effects: [] };
	}
}

export function reduce(state: UsageState, action: UsageAction): Transition {
	return action.type === "key" ? pressKey(state, action.key) : loadEvent(state, action);
}

/** Letters match in either case (`s` and `S`); Shift+Tab is its own key, so it steps back. */
const KEY_TABLE: readonly { key: UsageKey; ids: readonly KeyId[] }[] = [
	{ key: "next-view", ids: [Key.tab] },
	{ key: "previous-view", ids: [Key.shift("tab")] },
	{ key: "toggle-scope", ids: ["s", Key.shift("s")] },
	{ key: "close", ids: [Key.escape, "q", Key.shift("q"), Key.ctrl("c")] },
];

/** The action a chunk of terminal input stands for, or undefined for any other key. */
export function usageKeyFor(data: string): UsageKey | undefined {
	return KEY_TABLE.find(({ ids }) => ids.some((id) => matchesKey(data, id)))?.key;
}

export const USAGE_SYNTAX = "Usage: /dev-team usage [session|month]";

const SCOPE_ARGS: ReadonlyMap<string, Scope> = new Map([
	["", "session"],
	["session", "session"],
	["month", "month"],
]);

/** The overlay's starting transition for `/dev-team usage <args>`, or the usage message for an argument it does not know. */
export function parseUsageArgs(args: string): Transition | { error: string } {
	const scope = SCOPE_ARGS.get(args.trim().toLowerCase());
	return scope ? openUsage(scope) : { error: USAGE_SYNTAX };
}
