/**
 * Native replacements for the transcript-parsing hooks.
 *
 * - Cost meter (hooks/cost_meter.py + hooks/lib/cost_meter.py): appends one cumulative row per
 *   agent run to .claude/metrics/cost-metering.jsonl with the upstream row shape, so /cost-report,
 *   `cost_meter.py regression|pace` and /autoship --max-cost-usd keep working. Uses pi's own
 *   usage.cost (correct for every provider, including GitHub Copilot) instead of a Claude-only
 *   price table. Adds `session_id` (upstream could not, see run_report `joinable:false`).
 * - Context ceiling guard (hooks/context_ceiling_guard.py): same thresholds, env vars, messages and
 *   verdicts, measured with ctx.getContextUsage() which knows every model's window.
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
// Context ceiling guard
// ---------------------------------------------------------------------------

const RECOVERY_SKILLS = new Set(["handoff", "context-loading-protocol", "continue", "review-summary", "session-review"]);

const BLOCK_FOOTER =
	"[blocked: context ceiling] Run /handoff to summarize and continue in a fresh context — recovery skills are never gated, so it will run. Set DEV_TEAM_CONTEXT_STRICT=off to warn instead of blocking.";
const DELEGATION_FOOTER =
	"[not blocked: delegation] A subagent runs in its own context and returns only its result, so dispatching one is the cheapest way to do this work without growing THIS context — blocking it would push the work inline and cost more. Run /handoff to actually get back under the ceiling. Set DEV_TEAM_CONTEXT_GATE_AGENT=block to block these too.";

const BANDS = [
	["nudge", "Consider running /handoff (write a memory/ progress file, continue in a fresh context) and defer non-essential agents/skills."],
	["run-now", "Run /handoff now — write a memory/ progress file and continue in a fresh context."],
	["full-summary", "Write a full summary to memory/ and start a new conversation now — context is well past the effective ceiling."],
] as const;

function positiveIntEnv(name: string, def: number): number {
	const raw = process.env[name];
	if (!raw || !/^[0-9]+$/.test(raw)) return def;
	const v = Number(raw);
	return v > 0 ? v : def;
}

const lastBucket = new Map<string, number>();

export interface CeilingVerdict {
	block?: string;
	warn?: string;
}

/** @param kind "skill" (blocks) or "agent" (warns unless DEV_TEAM_CONTEXT_GATE_AGENT=block) */
export function contextCeiling(ctx: ExtensionContext, kind: "skill" | "agent", name: string): CeilingVerdict {
	if (process.env.DEV_TEAM_CONTEXT_CEILING === "off") return {};
	if (kind === "skill" && RECOVERY_SKILLS.has(name)) return {};
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens == null) return {};
	const override = positiveIntEnv("DEV_TEAM_CONTEXT_WINDOW", 0);
	const window = override || usage.contextWindow;
	if (!window) return {};
	const provenance = override ? "override" : "detected";
	const occ = usage.tokens;
	const pct = positiveIntEnv("DEV_TEAM_CONTEXT_CEILING_PCT", 40);
	const abs = positiveIntEnv("DEV_TEAM_CONTEXT_ABS_CEILING", 350_000);
	const pctTokens = Math.floor((pct * window) / 100);
	const threshold = Math.min(pctTokens, abs);
	if (occ < threshold) return {};
	const bound = pctTokens <= abs ? "percentage" : "absolute";
	const band = occ >= Math.floor((threshold * 3) / 2) ? 2 : occ >= Math.floor((threshold * 5) / 4) ? 1 : 0;
	const label = kind === "skill" ? `invoking skill '${name}'` : `loading agent '${name}'`;
	const diag = `Context at ${occ} of ${window} tokens — over the effective ceiling of ${threshold} tokens (${bound} bound; window ${provenance}) before ${label}.`;
	const [bandName, action] = BANDS[band];
	const msg =
		band === 2
			? `[${bandName}] ${action}\n${diag}`
			: `${diag}\n[${bandName}] ${action}\nTune with DEV_TEAM_CONTEXT_WINDOW / DEV_TEAM_CONTEXT_CEILING_PCT / DEV_TEAM_CONTEXT_ABS_CEILING; DEV_TEAM_CONTEXT_CEILING=off disables.`;
	const strict = (process.env.DEV_TEAM_CONTEXT_STRICT ?? "").trim().toLowerCase() !== "off";
	const blocks = kind === "skill" || (process.env.DEV_TEAM_CONTEXT_GATE_AGENT ?? "").trim().toLowerCase() === "block";
	if (strict && blocks) return { block: `${msg}\n${BLOCK_FOOTER}` };
	const session = ctx.sessionManager.getSessionId();
	const bucket = Math.max(band * 100, Math.floor(Math.floor((occ * 100) / window) / 5));
	const last = lastBucket.get(session) ?? 0;
	lastBucket.set(session, bucket);
	if (bucket <= last) return {};
	return { warn: strict && !blocks ? `${msg}\n${DELEGATION_FOOTER}` : msg };
}
