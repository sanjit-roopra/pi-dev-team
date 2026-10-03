/**
 * How this session's pi trust decision reaches the pi processes it starts (dev_team_subagent children
 * and the claude shim). pi decides trust per working directory, so a granted decision covers exactly
 * the session's directory, plus a worktree this session created of the repository rooted there. A
 * declined decision is always forwarded, so a saved /trust entry or defaultProjectTrust cannot
 * re-trust a child. Everywhere else the child decides for itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The directory as pi sees it: symlinks resolved, or just resolved when it does not exist. */
export function canonicalDir(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

export interface ChildTrust {
	/** pi's decision for the session (ctx.isProjectTrusted()). */
	projectTrusted: boolean;
	/** canonicalDir(ctx.cwd): the directory that decision is for. */
	sessionDir: string;
}

/** This session's decision, as children inherit it. */
export function childTrustOf(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ChildTrust {
	return { projectTrusted: ctx.isProjectTrusted(), sessionDir: canonicalDir(ctx.cwd) };
}

/**
 * Flags for a child pi running in `runCwd`. `worktreeRepoRoot` is the repository a worktree was made
 * from when the child runs in one this session created; it inherits trust only when that repository
 * root is the session's own directory.
 */
export function trustArgs(trust: ChildTrust, runCwd: string, worktreeRepoRoot?: string): string[] {
	if (!trust.projectTrusted) return ["--no-approve"];
	const here = canonicalDir(runCwd) === trust.sessionDir;
	const ownWorktree = worktreeRepoRoot !== undefined && canonicalDir(worktreeRepoRoot) === trust.sessionDir;
	return here || ownWorktree ? ["--approve"] : [];
}

/**
 * Environment for the claude shim (bin/claude): DEV_TEAM_TRUSTED_DIR is set only when trusted, and
 * the shim adds --approve only when it runs in exactly that directory; --no-approve rides in
 * DEV_TEAM_PI_ARGS when declined.
 */
export function shimTrustEnv(trust: ChildTrust, forwarded: string[]): { piArgs: string[]; trustedDir?: string } {
	return trust.projectTrusted ? { piArgs: forwarded, trustedDir: trust.sessionDir } : { piArgs: [...forwarded, "--no-approve"] };
}
