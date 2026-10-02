/**
 * Synthetic Claude Code subagent transcripts.
 *
 * The SubagentStop hooks (review_verdict_recorder.py, subagent_completion_guard.py,
 * task_completion_metrics.py) read a Claude-format sidechain transcript: the first record is the
 * dispatch prompt (user turn), assistant records carry `attributionAgent`, `message.content` blocks,
 * `message.stop_reason` and `message.usage`. pi children run with --no-session, so the subagent tool
 * records the child's JSON event stream and writes this equivalent file before firing SubagentStop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface PiContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: unknown;
	thinking?: string;
}

export interface PiMessageLike {
	role: string;
	content?: unknown;
	model?: string;
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

const STOP_MAP: Record<string, string | null> = {
	stop: "end_turn",
	toolUse: "tool_use",
	length: "max_tokens",
	error: null,
	aborted: null,
};

function contentBlocks(content: unknown): PiContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as PiContentBlock[]) : [];
}

export function buildTranscriptLines(opts: {
	agentName: string;
	agentId: string;
	sessionId: string;
	cwd: string;
	prompt: string;
	messages: PiMessageLike[];
}): string[] {
	const base = { isSidechain: true, agentId: opts.agentId, sessionId: opts.sessionId, cwd: opts.cwd };
	const attribution = `dev-team:${opts.agentName}`;
	const lines: string[] = [
		JSON.stringify({ ...base, type: "user", message: { role: "user", content: opts.prompt } }),
	];
	for (const m of opts.messages) {
		if (m.role === "assistant") {
			const blocks = contentBlocks(m.content)
				.map((b) => {
					if (b.type === "text") return { type: "text", text: b.text ?? "" };
					if (b.type === "toolCall") return { type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} };
					if (b.type === "thinking") return { type: "thinking", thinking: b.thinking ?? "" };
					return undefined;
				})
				.filter(Boolean);
			const u = m.usage ?? {};
			lines.push(
				JSON.stringify({
					...base,
					type: "assistant",
					attributionAgent: attribution,
					message: {
						role: "assistant",
						model: m.model,
						content: blocks,
						stop_reason: m.stopReason ? (STOP_MAP[m.stopReason] ?? null) : null,
						usage: {
							input_tokens: u.input ?? 0,
							output_tokens: u.output ?? 0,
							cache_read_input_tokens: u.cacheRead ?? 0,
							cache_creation_input_tokens: u.cacheWrite ?? 0,
						},
					},
				}),
			);
		} else if (m.role === "toolResult") {
			const text = contentBlocks(m.content)
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			lines.push(
				JSON.stringify({
					...base,
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: !!m.isError }],
					},
				}),
			);
		}
	}
	return lines;
}

export function transcriptDir(sessionId: string): string {
	const dir = path.join(os.tmpdir(), "pi-dev-team", sessionId.replace(/[^\w.-]/g, "_"), "subagents");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeTranscript(sessionId: string, agentId: string, lines: string[]): string {
	const file = path.join(transcriptDir(sessionId), `agent-${agentId}.jsonl`);
	fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	return file;
}
