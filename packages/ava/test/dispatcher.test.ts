import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";

describe("Dispatcher", () => {
	it("coalesces repeat enqueues while a thread is queued (idempotent enqueue)", async () => {
		let runs = 0;
		const d = new Dispatcher(async () => {
			runs++;
		});
		d.enqueue("A");
		d.enqueue("A");
		d.enqueue("A");
		await d.drain();
		expect(runs).toBe(1);
	});

	it("picks up a re-enqueue that arrives during an active run", async () => {
		const order: string[] = [];
		const d = new Dispatcher(async (tid) => {
			order.push(`start ${tid}`);
			if (order.length === 1) d.enqueue("A");
			await new Promise((r) => setTimeout(r, 5));
			order.push(`end ${tid}`);
		});
		d.enqueue("A");
		await d.drain();
		expect(order).toEqual(["start A", "end A", "start A", "end A"]);
	});

	it("runs different threads sequentially in v1 (single worker)", async () => {
		const order: string[] = [];
		const d = new Dispatcher(async (tid) => {
			order.push(`start ${tid}`);
			await new Promise((r) => setTimeout(r, 5));
			order.push(`end ${tid}`);
		});
		d.enqueue("A");
		d.enqueue("B");
		await d.drain();
		expect(order).toEqual(["start A", "end A", "start B", "end B"]);
	});
});
