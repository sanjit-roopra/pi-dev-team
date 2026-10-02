/**
 * Offline scripted model provider for end-to-end tests of pi-dev-team.
 *
 * Model: scripted/s1. Each response is decided from the transcript:
 * the first user message may contain a script block
 *
 *   <<script>>[ {"tool":"skill","args":{"name":"help"}}, {"text":"done"} ]<</script>>
 *
 * Step N of the script is played on the N-th assistant turn. A step is either
 * {"text": "..."} (final answer) or {"tool": name, "args": {...}} or
 * {"tools": [{"tool": name, "args": {...}}, ...]} (parallel calls in one message).
 * {"inspect": "runtime"} returns the model-facing system prompt and active tool names.
 * When the script is exhausted the model answers with the last tool result text
 * (prefixed "ECHO:") so tests can assert on what tools returned.
 * Each assistant message reports fixed usage so cost accounting can be tested.
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { text?: string; inspect?: "runtime"; tool?: string; args?: Record<string, unknown>; tools?: { tool: string; args?: Record<string, unknown> }[] };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
			.join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	const handle = fauxProvider({
		provider: "scripted",
		models: [{ id: "s1", name: "Scripted", contextWindow: 200000, maxTokens: 8000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
	});
	let counter = 0;
	const factory = (context: { messages: { role: string; content: unknown }[] }) => {
		const msgs = context.messages.filter((m) => m.role !== "system");
		const firstUser = msgs.find((m) => m.role === "user");
		const firstText = firstUser ? textOf(firstUser.content) : "";
		const match = firstText.match(/<<script>>([\s\S]*)<<\/script>>/);
		const assistantTurns = msgs.filter((m) => m.role === "assistant").length;
		let msg;
		if (match) {
			const steps = JSON.parse(match[1]) as Step[];
			const step = steps[assistantTurns];
			if (step?.inspect === "runtime") {
				msg = fauxAssistantMessage([fauxText(JSON.stringify({
					systemPrompt: getCurrentSystemPrompt(context.messages),
					tools: getCurrentTools(context.messages).map((t) => t.name),
				}))]);
			} else if (step?.tools) {
				msg = fauxAssistantMessage(
					step.tools.map((t) => fauxToolCall(t.tool, (t.args ?? {}) as never, { id: `call_${++counter}` })),
					{ stopReason: "toolUse" },
				);
			} else if (step?.tool) {
				msg = fauxAssistantMessage([fauxToolCall(step.tool, (step.args ?? {}) as never, { id: `call_${++counter}` })], {
					stopReason: "toolUse",
				});
			} else if (step?.text) {
				msg = fauxAssistantMessage([fauxText(step.text)]);
			}
		}
		if (!msg) {
			const last = msgs[msgs.length - 1];
			msg = fauxAssistantMessage([fauxText(`ECHO:${last ? textOf(last.content) : ""}`)]);
		}
		msg.provider = "scripted";
		msg.model = "s1";
		msg.usage = {
			input: 1000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1100,
			cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
		};
		return msg;
	};
	handle.setResponses(Array.from({ length: 500 }, () => factory as never));
	pi.registerProvider(handle.provider as never);
}
