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

	it("picks up a re-enqueue that arrives during an active run (per-thread serialized)", async () => {
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

	it("with maxWorkers=1, runs different threads sequentially", async () => {
		const order: string[] = [];
		const d = new Dispatcher(
			async (tid) => {
				order.push(`start ${tid}`);
				await new Promise((r) => setTimeout(r, 5));
				order.push(`end ${tid}`);
			},
			{ maxWorkers: 1 },
		);
		d.enqueue("A");
		d.enqueue("B");
		await d.drain();
		expect(order).toEqual(["start A", "end A", "start B", "end B"]);
	});

	it("with maxWorkers=2, runs different threads concurrently (interleaved start)", async () => {
		const order: string[] = [];
		const d = new Dispatcher(
			async (tid) => {
				order.push(`start ${tid}`);
				await new Promise((r) => setTimeout(r, 20));
				order.push(`end ${tid}`);
			},
			{ maxWorkers: 2 },
		);
		d.enqueue("A");
		d.enqueue("B");
		await d.drain();
		// A and B both started before either ended → interleaved
		expect(order[0]).toBe("start A");
		expect(order[1]).toBe("start B");
		expect(order.slice(2).sort()).toEqual(["end A", "end B"]);
	});

	it("with maxWorkers=2, still serializes same thread (A re-enqueued during its own run)", async () => {
		const order: string[] = [];
		const d = new Dispatcher(
			async (tid) => {
				order.push(`start ${tid}`);
				if (tid === "A" && order.filter((e) => e === "start A").length === 1) {
					d.enqueue("A");
				}
				await new Promise((r) => setTimeout(r, 10));
				order.push(`end ${tid}`);
			},
			{ maxWorkers: 2 },
		);
		d.enqueue("A");
		await d.drain();
		// A ran twice, strictly serialized — never two "start A" in a row without "end A" between
		expect(order).toEqual(["start A", "end A", "start A", "end A"]);
	});

	it("with maxWorkers=2 and 3 threads, caps concurrency (third waits)", async () => {
		const events: Array<{ tid: string; kind: "start" | "end"; t: number }> = [];
		const start = Date.now();
		const d = new Dispatcher(
			async (tid) => {
				events.push({ tid, kind: "start", t: Date.now() - start });
				await new Promise((r) => setTimeout(r, 30));
				events.push({ tid, kind: "end", t: Date.now() - start });
			},
			{ maxWorkers: 2 },
		);
		d.enqueue("A");
		d.enqueue("B");
		d.enqueue("C");
		await d.drain();
		const startCs = events.filter((e) => e.tid === "C" && e.kind === "start")[0];
		const endAs = events.filter((e) => e.kind === "end")[0];
		// C starts only after one of A/B has ended — never all three concurrent
		expect(startCs.t).toBeGreaterThanOrEqual(endAs.t);
	});
});
