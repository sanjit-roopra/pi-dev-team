/**
 * Small tools the dev-team content expects from Claude Code:
 *   ask_user  — AskUserQuestion (human gates in /plan, /specs, /build, /setup, ...)
 *   web_fetch — WebFetch (source-verification, competitive-analysis)
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OptionSchema = Type.Object({
	label: Type.String(),
	description: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask" }),
	header: Type.Optional(Type.String({ description: "Short label" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Choices; omit for a free-text answer" })),
	multiSelect: Type.Optional(Type.Boolean()),
});

const AskParams = Type.Object({
	question: Type.Optional(Type.String({ description: "Single question (or use `questions`)" })),
	options: Type.Optional(Type.Array(Type.Union([Type.String(), OptionSchema]))),
	multiSelect: Type.Optional(Type.Boolean()),
	questions: Type.Optional(Type.Array(QuestionSchema, { description: "Several questions (Claude AskUserQuestion shape)" })),
});

type Q = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

const OTHER = "Other (type an answer)";

async function askOne(q: Q, ctx: ExtensionContext): Promise<string | undefined> {
	const title = q.header ? `${q.header}: ${q.question}` : q.question;
	if (!q.options?.length) return ctx.ui.input(title);
	const labels = q.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
	if (q.multiSelect) {
		const listing = labels.map((l, i) => `${i + 1}. ${l}`).join("\n");
		const raw = await ctx.ui.input(`${title}\n${listing}\nEnter numbers separated by commas, or free text`);
		if (raw === undefined) return undefined;
		const picks = raw
			.split(",")
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n) && n >= 1 && n <= labels.length);
		return picks.length ? picks.map((n) => q.options?.[n - 1]?.label).join(", ") : raw;
	}
	const choice = await ctx.ui.select(title, [...labels, OTHER]);
	if (choice === undefined) return undefined;
	if (choice === OTHER) return ctx.ui.input(title);
	return q.options[labels.indexOf(choice)]?.label ?? choice;
}

export function registerAskUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the human one or more questions (Claude Code's AskUserQuestion). Use for dev-team human gates: approvals, ambiguity resolution, choices. In non-interactive runs it returns that no human is attached; then take the documented non-interactive default.",
		promptSnippet: "Ask the human a question (AskUserQuestion equivalent)",
		parameters: AskParams,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions: Q[] = params.questions?.length
				? (params.questions as Q[])
				: params.question
					? [
							{
								question: params.question,
								options: params.options?.map((o) => (typeof o === "string" ? { label: o } : o)),
								multiSelect: params.multiSelect,
							},
						]
					: [];
			if (!questions.length) throw new Error("Provide `question` or `questions`.");
			if (!ctx.hasUI || process.env.DEV_TEAM_INTERACTIVE !== "1") {
				return {
					content: [
						{
							type: "text",
							text: "NON-INTERACTIVE: no human is attached to this run. Do not wait. Apply the documented non-interactive default for this gate and record that you did.",
						},
					],
					details: { answered: false },
				};
			}
			const answers: { question: string; answer: string | null }[] = [];
			for (const q of questions) {
				const a = await askOne(q, ctx);
				answers.push({ question: q.question, answer: a ?? null });
			}
			const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(dismissed — no answer)"}`).join("\n\n");
			return { content: [{ type: "text", text }], details: { answered: true, answers } };
		},
	});
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

const FETCH_CAP = 60_000;

export function registerWebFetch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch a URL and return its text (Claude Code's WebFetch). HTML is converted to plain text; output is capped. `prompt` states what you are looking for; extract it yourself from the returned text.",
		promptSnippet: "Fetch a web page as text (WebFetch equivalent)",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL" }),
			prompt: Type.Optional(Type.String({ description: "What to look for in the page" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const url = params.url.replace(/^http:\/\//, "https://");
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 30_000);
			signal?.addEventListener("abort", () => controller.abort(), { once: true });
			try {
				const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "pi-dev-team/1.0" } });
				const type = res.headers.get("content-type") ?? "";
				const raw = await res.text();
				let text = type.includes("html") ? htmlToText(raw) : raw;
				const truncated = text.length > FETCH_CAP;
				if (truncated) text = `${text.slice(0, FETCH_CAP)}\n\n[truncated: ${text.length - FETCH_CAP} more characters]`;
				const head = `URL: ${res.url}\nStatus: ${res.status}\nContent-Type: ${type}${params.prompt ? `\nLooking for: ${params.prompt}` : ""}\n\n`;
				if (!res.ok) throw new Error(`${head}HTTP ${res.status}`);
				return { content: [{ type: "text", text: head + text }], details: { status: res.status, truncated } };
			} finally {
				clearTimeout(timer);
			}
		},
	});
}
