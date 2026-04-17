export type ThreadRunner = (threadId: string) => Promise<void>;

/**
 * Per-thread FIFO dispatcher with cross-thread concurrency.
 *
 * Invariants:
 * - A given threadId is NEVER executed by more than one runner at a time
 *   (same-thread work is strictly serialized — keeps session state sane).
 * - Up to `maxWorkers` different threads run in parallel.
 * - Re-enqueues of a thread that is currently running are deferred until
 *   the current run for that thread finishes, then picked up again.
 */
export class Dispatcher {
	private pending = new Set<string>();
	private queue: string[] = [];
	private running = new Set<string>();
	private readonly maxWorkers: number;
	private dispatching = false;

	constructor(
		private runner: ThreadRunner,
		opts: { maxWorkers?: number } = {},
	) {
		this.maxWorkers = Math.max(1, opts.maxWorkers ?? 1);
	}

	enqueue(threadId: string): void {
		if (this.pending.has(threadId)) return;
		this.pending.add(threadId);
		this.queue.push(threadId);
		void this.tryDispatch();
	}

	private async tryDispatch(): Promise<void> {
		if (this.dispatching) return;
		this.dispatching = true;
		// Yield once so synchronous burst enqueues all land before we start processing.
		await Promise.resolve();
		try {
			while (this.queue.length > 0 && this.running.size < this.maxWorkers) {
				// Find first queued tid that isn't already running. Leave running ones
				// in the queue; they'll be picked up after the current run finishes.
				const idx = this.queue.findIndex((t) => !this.running.has(t));
				if (idx === -1) break;
				const tid = this.queue.splice(idx, 1)[0];
				this.pending.delete(tid);
				this.running.add(tid);
				void this.runOne(tid);
			}
		} finally {
			this.dispatching = false;
		}
	}

	private async runOne(tid: string): Promise<void> {
		try {
			await this.runner(tid);
		} finally {
			this.running.delete(tid);
			void this.tryDispatch();
		}
	}

	async drain(): Promise<void> {
		while (this.running.size > 0 || this.queue.length > 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
	}
}
