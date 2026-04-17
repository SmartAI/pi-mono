import { spawn } from "node:child_process";
import type { BackendRunResult } from "./backends/types.js";

export interface SandboxExecOpts {
	env?: Record<string, string>;
	timeoutMs: number;
	workdir?: string; // forwarded as `docker exec --workdir <path>` (none of the agent CLIs have --cwd)
}

export interface SandboxConfig {
	containerName: string;
	/** UID to run commands as inside the container. With podman's --userns=keep-id the
	 * host UID passes through, so 1000 (Max on Fedora) maps to 1000 inside the
	 * container and the mounted credential files are readable. claude-code's
	 * "no --dangerously-skip-permissions as root" guard is satisfied because UID 1000
	 * is non-root in the container too. */
	execUid?: number;
	/** HOME dir inside the container for the exec user. Must be where mounted
	 * credentials live (~/.claude, ~/.codex, ~/.pi). */
	execHome?: string;
}

export function makeSandboxExec(cfg: SandboxConfig) {
	const uid = cfg.execUid ?? 1000;
	const home = cfg.execHome ?? "/home/ava";
	return async (argv: string[], opts: SandboxExecOpts): Promise<BackendRunResult> => {
		const dockerArgv = ["exec", "-i", "-u", String(uid), "-e", `HOME=${home}`];
		if (opts.workdir) dockerArgv.push("--workdir", opts.workdir);
		for (const [k, v] of Object.entries(opts.env ?? {})) {
			dockerArgv.push("-e", `${k}=${v}`);
		}
		dockerArgv.push(cfg.containerName, ...argv);
		const start = Date.now();
		return new Promise((resolve) => {
			const c = spawn("docker", dockerArgv, { stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				c.kill("SIGKILL");
			}, opts.timeoutMs);
			c.stdout.on("data", (d) => {
				out += d.toString();
			});
			c.stderr.on("data", (d) => {
				err += d.toString();
			});
			c.on("close", (code) => {
				clearTimeout(timer);
				resolve({
					exitCode: timedOut ? 124 : (code ?? 1),
					stdout: out,
					stderr: err,
					durationMs: Date.now() - start,
					timedOut,
				});
			});
		});
	};
}
