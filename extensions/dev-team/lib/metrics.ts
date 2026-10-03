/**
 * Native replacements for the transcript-parsing hooks.
 *
 * - Cost meter (hooks/cost_meter.py + hooks/lib/cost_meter.py): appends one cumulative row per
 *   agent run to .claude/metrics/cost-metering.jsonl with the upstream row shape, so /cost-report,
 *   `cost_meter.py regression|pace` and /autoship --max-cost-usd keep working. Uses pi's own
 *   usage.cost (correct for every provider, including GitHub Copilot) instead of a Claude-only
 *   price table. Adds `session_id` (upstream could not, see run_report `joinable:false`).
 * - Autocompact: honours upstream's CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (written by /setup) by compacting
 *   the session at that percentage, measured with ctx.getContextUsage() which knows every model's window.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_USAGE_ENTRY } from "./subagent.ts";

export function projectRoot(cwd: string): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
	const out = (r.stdout ?? "").trim();
	return r.status === 0 && out ? out : cwd;
}

export function telemetryConsent(): boolean {
	try {
		const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "telemetry.json"), "utf-8"));
		return data?.enabled === true;
	} catch {
		return false;
	}
}

type Bucket = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	cost_usd: number;
	messages: number;
};

const newBucket = (): Bucket => ({
	input_tokens: 0,
	output_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	cost_usd: 0,
	messages: 0,
});

interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number } | number;
}

function add(bucket: Bucket, u: PiUsage, messages: number): void {
	bucket.input_tokens += u.input ?? 0;
	bucket.output_tokens += u.output ?? 0;
	bucket.cache_read_input_tokens += u.cacheRead ?? 0;
	bucket.cache_creation_input_tokens += u.cacheWrite ?? 0;
	bucket.cost_usd += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
	bucket.messages += messages;
}

function slim(map: Record<string, Bucket>): Record<string, Omit<Bucket, "messages">> {
	const out: Record<string, Omit<Bucket, "messages">> = {};
	for (const [k, b] of Object.entries(map)) {
		const { messages: _m, ...rest } = b;
		out[k] = { ...rest, cost_usd: Math.round(rest.cost_usd * 1e6) / 1e6 };
	}
	return out;
}

/** Build the cumulative cost row for the whole session (every branch, like upstream's whole-transcript sum). */
export function buildCostRow(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const total = newBucket();
	const byModel: Record<string, Bucket> = {};
	const byThread: Record<string, Bucket> = {};
	const byAgent: Record<string, Bucket> = {};
	const bump = (map: Record<string, Bucket>, key: string, u: PiUsage, n: number) => {
		map[key] ??= newBucket();
		add(map[key], u, n);
	};
	let any = false;
	for (const entry of ctx.sessionManager.getEntries() as unknown as Record<string, unknown>[]) {
		if (entry.type === "message") {
			const msg = entry.message as { role?: string; usage?: PiUsage; model?: string; provider?: string } | undefined;
			if (msg?.role !== "assistant" || !msg.usage) continue;
			const model = msg.provider ? `${msg.provider}/${msg.model}` : String(msg.model ?? "unknown");
			add(total, msg.usage, 1);
			bump(byModel, model, msg.usage, 1);
			bump(byThread, "main", msg.usage, 1);
			bump(byAgent, "main", msg.usage, 1);
			any = true;
		} else if (entry.type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY) {
			const d = entry.data as { agent: string; model?: string; usage: PiUsage & { turns?: number } } | undefined;
			if (!d?.usage) continue;
			const n = d.usage.turns ?? 0;
			add(total, d.usage, n);
			bump(byModel, d.model ?? "unknown", d.usage, n);
			bump(byThread, "subagent", d.usage, n);
			bump(byAgent, `dev-team:${d.agent}`, d.usage, n);
			any = true;
		}
	}
	if (!any) return undefined;
	const file = ctx.sessionManager.getSessionFile();
	return {
		timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		transcript: file ? path.basename(file) : `${ctx.sessionManager.getSessionId()}.jsonl`,
		session_id: ctx.sessionManager.getSessionId(),
		total: { ...total, cost_usd: Math.round(total.cost_usd * 1e6) / 1e6 },
		by_model: slim(byModel),
		by_thread: slim(byThread),
		by_agent_type: slim(byAgent),
		unpriced_models: [],
		source: "pi-dev-team",
	};
}

export function recordCost(ctx: ExtensionContext): string | undefined {
	if (process.env.DEV_TEAM_COST_METER === "off" || !telemetryConsent()) return undefined;
	const row = buildCostRow(ctx);
	if (!row) return undefined;
	const file = path.join(projectRoot(ctx.cwd), ".claude", "metrics", "cost-metering.jsonl");
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf-8");
		return file;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Autocompact (replaces upstream's retired context ceiling guard, dev-team v14)
// ---------------------------------------------------------------------------

export const AUTOCOMPACT_KEY = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const PCT_RE = /^(?:100|[1-9][0-9]?)$/;

export interface AutocompactSetting {
	/** Valid integer 1-100, or undefined when absent/invalid. */
	pct?: number;
	raw?: unknown;
	source?: string;
}

function envBlock(file: string): Record<string, unknown> | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		return data && typeof data === "object" && data.env && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Same precedence as upstream hooks/lib/autocompact_config.py `detect`: process env,
 * `.claude/settings.local.json`, `.claude/settings.json`, then user settings. The first source
 * defining the key decides, so `/setup` (scripts/set_autocompact_env.py) configures pi too.
 */
export function autocompactSetting(projectDir: string, env: NodeJS.ProcessEnv = process.env): AutocompactSetting {
	const pick = (raw: unknown, source: string): AutocompactSetting => ({
		pct: typeof raw === "string" && PCT_RE.test(raw) ? Number(raw) : undefined,
		raw,
		source,
	});
	if (env[AUTOCOMPACT_KEY] !== undefined) return pick(env[AUTOCOMPACT_KEY], "process env");
	const userSettings = env.CLAUDE_CONFIG_DIR
		? path.join(env.CLAUDE_CONFIG_DIR, "settings.json")
		: path.join(env.HOME || os.homedir(), ".claude", "settings.json");
	const candidates: [string, string][] = [
		["settings.local.json", path.join(projectDir, ".claude", "settings.local.json")],
		["settings.json", path.join(projectDir, ".claude", "settings.json")],
		["user settings.json", userSettings],
	];
	for (const [label, file] of candidates) {
		const block = envBlock(file);
		if (block && AUTOCOMPACT_KEY in block) return pick(block[AUTOCOMPACT_KEY], label);
	}
	return {};
}

/**
 * Whether the main session should compact now. pi's own auto-compaction only triggers at
 * `contextWindow - reserveTokens`; this lowers the threshold to the configured percentage, the
 * way CLAUDE_AUTOCOMPACT_PCT_OVERRIDE lowers Claude Code's. Unconfigured repos keep pi's default
 * (and get the autocompact_setup_nudge advisory at session start).
 */
export function autocompactDue(ctx: ExtensionContext): { pct: number; percent: number } | undefined {
	const { pct } = autocompactSetting(ctx.cwd);
	if (pct === undefined) return undefined;
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent == null) return undefined;
	return usage.percent >= pct ? { pct, percent: usage.percent } : undefined;
}
