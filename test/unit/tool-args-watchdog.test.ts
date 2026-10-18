import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_TEAM_SUBAGENT_TOOL } from "../../extensions/dev-team/lib/agents.ts";
import { DISPATCH_ARGS_LIMIT, TOOL_ARGS_LIMIT, ToolArgsWatchdog } from "../../extensions/dev-team/lib/tool-args-watchdog.ts";

const fill = (watchdog: ToolArgsWatchdog, chars: number, toolName: string, contentIndex = 0) => watchdog.add(contentIndex, "x".repeat(chars), toolName);

for (const [toolName, limit] of [
	[DEV_TEAM_SUBAGENT_TOOL, DISPATCH_ARGS_LIMIT],
	["write", TOOL_ARGS_LIMIT],
] as const) {
	test(`tool args watchdog: ${toolName} trips only past its limit`, () => {
		assert.equal(fill(new ToolArgsWatchdog(), limit - 1, toolName), undefined, "limit - 1");
		assert.equal(fill(new ToolArgsWatchdog(), limit, toolName), undefined, "limit");
		assert.deepEqual(fill(new ToolArgsWatchdog(), limit + 1, toolName), { toolName, chars: limit + 1, limit });
	});
}

test("tool args watchdog: deltas add up per tool call, not across calls", () => {
	const watchdog = new ToolArgsWatchdog();
	assert.equal(fill(watchdog, DISPATCH_ARGS_LIMIT, DEV_TEAM_SUBAGENT_TOOL, 0), undefined);
	assert.equal(fill(watchdog, DISPATCH_ARGS_LIMIT, DEV_TEAM_SUBAGENT_TOOL, 1), undefined, "another call has its own count");
	assert.ok(fill(watchdog, 1, DEV_TEAM_SUBAGENT_TOOL, 0), "the first call passes its limit");
});

test("tool args watchdog: fires once per message, again after reset", () => {
	const watchdog = new ToolArgsWatchdog();
	assert.ok(fill(watchdog, DISPATCH_ARGS_LIMIT + 1, DEV_TEAM_SUBAGENT_TOOL));
	assert.equal(fill(watchdog, 1, DEV_TEAM_SUBAGENT_TOOL), undefined, "same call");
	assert.equal(fill(watchdog, DISPATCH_ARGS_LIMIT + 1, DEV_TEAM_SUBAGENT_TOOL, 1), undefined, "other call");
	watchdog.reset();
	assert.equal(fill(watchdog, 1, DEV_TEAM_SUBAGENT_TOOL), undefined, "counts start again");
	assert.ok(fill(watchdog, DISPATCH_ARGS_LIMIT, DEV_TEAM_SUBAGENT_TOOL));
});
