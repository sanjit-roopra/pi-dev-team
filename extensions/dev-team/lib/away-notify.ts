/**
 * Tells a human who is away that the run went on without them (config `notify`). pi itself cannot
 * push to a phone; ntfy (https://ntfy.sh) can, with only its app installed. Anyone who knows a topic
 * name on ntfy.sh can read it, so pick a long random one. Sending never blocks or fails the run.
 */

const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const SEND_TIMEOUT_MS = 5000;
const MAX_MESSAGE_CHARS = 3500;

/** The URL to POST to for a `notify` setting, or undefined when it names no valid target. */
export function notifyUrl(setting: string): string | undefined {
	const target = setting.trim().match(/^ntfy:(.+)$/)?.[1]?.trim();
	if (!target) return undefined;
	if (NTFY_TOPIC.test(target)) return `https://ntfy.sh/${target}`;
	try {
		const url = new URL(target);
		return url.protocol === "https:" && url.pathname.length > 1 ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** POST `message` to the target. Resolves to an error text, or undefined when sent or there is no target. */
export async function sendAway(
	setting: string,
	title: string,
	message: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
	const url = notifyUrl(setting);
	if (!url) return setting.trim() ? `dev-team: "notify": "${setting}" is not ntfy:<topic> or ntfy:<https url>; nothing sent.` : undefined;
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			body: message.slice(0, MAX_MESSAGE_CHARS),
			headers: { Title: title.replace(/[^\x20-\x7e]/g, "") },
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		return res.ok ? undefined : `dev-team: notify got HTTP ${res.status} from ${new URL(url).host}.`;
	} catch (e) {
		return `dev-team: notify failed: ${(e as Error).message}`;
	}
}
