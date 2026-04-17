import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearOutgoing, scanOutgoing } from "../src/outgoing.js";

describe("outgoing scan", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ava-out-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns files with size", async () => {
		await mkdir(join(dir, "outgoing"), { recursive: true });
		await writeFile(join(dir, "outgoing", "a.png"), Buffer.alloc(1024));
		await writeFile(join(dir, "outgoing", "b.txt"), "hello");
		const r = await scanOutgoing(dir, 10 * 1024 * 1024);
		expect(r.attached.map((a) => a.filename).sort()).toEqual(["a.png", "b.txt"]);
		expect(r.overflow).toEqual([]);
	});

	it("overflows beyond the cap", async () => {
		await mkdir(join(dir, "outgoing"), { recursive: true });
		await writeFile(join(dir, "outgoing", "big.bin"), Buffer.alloc(900_000));
		await writeFile(join(dir, "outgoing", "also.bin"), Buffer.alloc(900_000));
		await writeFile(join(dir, "outgoing", "tiny.txt"), "ok");
		const r = await scanOutgoing(dir, 1_000_000);
		const attachedNames = r.attached.map((a) => a.filename).sort();
		const overflowNames = r.overflow.map((a) => a.filename).sort();
		expect(attachedNames.length + overflowNames.length).toBe(3);
		const totalAttached = r.attached.reduce((n, a) => n + a.bytes, 0);
		expect(totalAttached).toBeLessThanOrEqual(1_000_000);
	});

	it("clear empties the outgoing dir", async () => {
		await mkdir(join(dir, "outgoing"), { recursive: true });
		await writeFile(join(dir, "outgoing", "stale.txt"), "old");
		await clearOutgoing(dir);
		const r = await scanOutgoing(dir, 1_000_000);
		expect(r.attached).toEqual([]);
	});

	it("skips reply-body filenames (reply.txt, message.md, etc.) so the reply isn't attached to itself", async () => {
		await mkdir(join(dir, "outgoing"), { recursive: true });
		await writeFile(join(dir, "outgoing", "reply.txt"), "the whole email body got dumped here by mistake");
		await writeFile(join(dir, "outgoing", "message.md"), "same");
		await writeFile(join(dir, "outgoing", "draft.eml"), "same");
		await writeFile(join(dir, "outgoing", "response.html"), "<p>same</p>");
		await writeFile(join(dir, "outgoing", "screenshot.png"), Buffer.alloc(100));
		const r = await scanOutgoing(dir, 10 * 1024 * 1024);
		expect(r.attached.map((a) => a.filename)).toEqual(["screenshot.png"]);
		expect(r.overflow).toEqual([]);
	});
});
