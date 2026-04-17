import { spawn } from "node:child_process";
import type { BackendRunResult } from "./backends/types.js";

export interface SandboxExecOpts {
	env?: Record<string, string>;
	timeoutMs: number;
	workdir?: string; // forwarded as `docker exec --workdir <path>` (none of the agent CLIs have --cwd)
}

export interface SandboxConfig {
	containerName: string;
}

export function makeSandboxExec(cfg: SandboxConfig) {
	return async (argv: string[], opts: SandboxExecOpts): Promise<BackendRunResult> => {
		const dockerArgv = ["exec", "-i"];
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
