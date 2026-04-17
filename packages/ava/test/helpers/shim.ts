import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendRunResult } from "../../src/backends/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, "../fixtures/shims/fake-cli.sh");

export function makeShimExec(env: Record<string, string>) {
	return async (
		argv: string[],
		_opts: { env?: Record<string, string>; timeoutMs: number; workdir?: string },
	): Promise<BackendRunResult> => {
		const start = Date.now();
		return new Promise((resolve) => {
			const c = spawn(shim, argv, { env: { ...process.env, ...env } });
			let out = "";
			let err = "";
			c.stdout.on("data", (d) => {
				out += d.toString();
			});
			c.stderr.on("data", (d) => {
				err += d.toString();
			});
			c.on("close", (code) => {
				resolve({
					exitCode: code ?? 1,
					stdout: out,
					stderr: err,
					durationMs: Date.now() - start,
					timedOut: false,
				});
			});
		});
	};
}
