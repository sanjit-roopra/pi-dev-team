import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "External subagent",
		description: "Offline stand-in for another extension's generic subagent tool.",
		parameters: Type.Object({ task: Type.String() }),
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: `EXTERNAL_SUBAGENT:${params.task}` }],
				details: { source: "external-subagent-fixture", task: params.task, pid: process.pid },
			};
		},
	});
}
