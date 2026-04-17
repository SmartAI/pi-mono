/**
 * Manual integration test. Run on the Fedora host once after setup-sandbox.sh.
 *
 *   npx tsx packages/ava/test/integration/sandbox-smoke.ts
 *
 * Fails with exit != 0 if any check fails. Writes a report to stdout.
 */
import { makeSandboxExec } from "../../src/sandbox.js";

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn();
		console.log(`OK   ${name}`);
		return true;
	} catch (e) {
		console.error(`FAIL ${name}: ${e}`);
		return false;
	}
}

async function main(): Promise<void> {
	const exec = makeSandboxExec({ containerName: process.env.AVA_CONTAINER ?? "ava-sandbox" });
	const cases = [
		["claude --version", ["claude", "--version"]],
		["codex --version", ["codex", "--version"]],
		["pi --version", ["pi", "--version"]],
		["git --version", ["git", "--version"]],
		["gh --version", ["gh", "--version"]],
		["ls /workspace", ["ls", "/workspace"]],
	] as const;
	let ok = true;
	for (const [name, argv] of cases) {
		const r = await exec([...argv], { timeoutMs: 10_000 });
		ok =
			(await check(name, async () => {
				if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr}`);
			})) && ok;
	}
	process.exit(ok ? 0 : 1);
}

main();
