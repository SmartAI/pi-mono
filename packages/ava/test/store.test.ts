import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

describe("Store", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ava-store-"));
		store = new Store(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates thread dirs and appends inbound messages to log.jsonl", async () => {
		await store.appendInbound("T-abc", {
			kind: "inbound",
			gmailMessageId: "<m1@x>",
			from: "brian@actualvoice.ai",
			at: "2026-04-16T12:00:00Z",
			subject: "hi",
			bodyText: "hello",
		});
		const content = await readFile(join(dir, "threads", "T-abc", "log.jsonl"), "utf-8");
		expect(content.trim().split("\n")).toHaveLength(1);
		const row = JSON.parse(content.trim());
		expect(row.kind).toBe("inbound");
		expect(row.gmailMessageId).toBe("<m1@x>");
	});

	it("dedups by gmailMessageId across inbound appends", async () => {
		const entry = {
			kind: "inbound" as const,
			gmailMessageId: "<dup@x>",
			from: "x@y",
			at: "2026-04-16T12:00:00Z",
			subject: "s",
			bodyText: "b",
		};
		await store.appendInbound("T-1", entry);
		await store.appendInbound("T-1", entry); // same id, should be ignored
		const rows = (await readFile(join(dir, "threads", "T-1", "log.jsonl"), "utf-8")).trim().split("\n");
		expect(rows).toHaveLength(1);
	});

	it("lists known thread ids from the threads/ dir", async () => {
		await store.appendInbound("T-a", {
			kind: "inbound",
			gmailMessageId: "<1@x>",
			from: "u@v",
			at: "2026-04-16T12:00:00Z",
			subject: "",
			bodyText: "",
		});
		await store.appendInbound("T-b", {
			kind: "inbound",
			gmailMessageId: "<2@x>",
			from: "u@v",
			at: "2026-04-16T12:00:00Z",
			subject: "",
			bodyText: "",
		});
		expect(await store.listThreadIds()).toEqual(expect.arrayContaining(["T-a", "T-b"]));
	});
});
