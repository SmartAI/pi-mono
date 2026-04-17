/**
 * Verify each real backend preserves conversation history across invocations.
 *
 *   AVA_CONTAINER=ava-sandbox \
 *   AVA_BACKEND=claude-code \
 *     npx tsx packages/ava/test/integration/backend-session-reuse.ts
 *
 * Also run with AVA_BACKEND=codex and AVA_BACKEND=pi.
 */
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import { CodexBackend } from "../../src/backends/codex.js";
import { PiBackend } from "../../src/backends/pi.js";
import type { Backend } from "../../src/backends/types.js";
import { makeSandboxExec } from "../../src/sandbox.js";

function pick(name: string): Backend {
	if (name === "claude-code") return new ClaudeCodeBackend();
	if (name === "codex") return new CodexBackend();
	if (name === "pi") return new PiBackend();
	throw new Error(`unknown backend ${name}`);
}

async function main(): Promise<void> {
	const backendName = process.env.AVA_BACKEND ?? "claude-code";
	const backend = pick(backendName);
	const dataDir = mkdtempSync(join(tmpdir(), "ava-it-"));
	await mkdir(join(dataDir, "threads", "T-it"), { recursive: true });
	const exec = makeSandboxExec({ containerName: process.env.AVA_CONTAINER ?? "ava-sandbox" });

	const r1 = await backend.run({
		threadId: "T-it",
		cwdInContainer: "/workspace",
		prompt: "My favorite number is 73. Please reply with just the word 'noted'.",
		dataDir,
		timeoutMs: 120_000,
		sandboxExec: exec,
	});
	console.log(`run1 exit=${r1.exitCode} stdout=${r1.stdout.slice(0, 200)}`);
	if (r1.exitCode !== 0) process.exit(1);

	const r2 = await backend.run({
		threadId: "T-it",
		cwdInContainer: "/workspace",
		prompt: "What is my favorite number? Reply with only the number.",
		dataDir,
		timeoutMs: 120_000,
		sandboxExec: exec,
	});
	console.log(`run2 exit=${r2.exitCode} stdout=${r2.stdout.slice(0, 200)}`);
	if (r2.exitCode !== 0) process.exit(1);
	if (!r2.stdout.includes("73")) {
		console.error("FAIL: backend did not remember the number across runs");
		process.exit(1);
	}
	console.log(`PASS: ${backendName} preserved history`);
}

main();
