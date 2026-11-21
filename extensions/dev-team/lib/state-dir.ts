/**
 * Where dev-team keeps its project state: `.pi/dev-team/` under the project (memory, metrics, plans,
 * hooks state, worktrees, ...). Never `.pi` alone: `.pi/agents`, `.pi/skills`, `.pi/settings.json` and
 * `.pi/dev-team.json` are project config, not state, and must stay gated and tracked.
 * The Python side uses the same folder (hooks/lib/artifact_paths.py STATE_DIR).
 */
import * as path from "node:path";

export const STATE_DIR = path.join(".pi", "dev-team");
/** The same folder with "/" separators, for git pathspecs and text. */
export const STATE_DIR_POSIX = ".pi/dev-team";
