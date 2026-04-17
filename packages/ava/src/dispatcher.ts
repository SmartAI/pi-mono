export type ThreadRunner = (threadId: string) => Promise<void>;

export class Dispatcher {
	private pending = new Set<string>();
	private queue: string[] = [];
	private active = false;

	constructor(private runner: ThreadRunner) {}

	enqueue(threadId: string): void {
		if (this.pending.has(threadId)) return;
		this.pending.add(threadId);
		this.queue.push(threadId);
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.active) return;
		this.active = true;
		// Yield once so synchronous burst enqueues all land before we start processing;
		// without this, the first runner() invocation runs before dup-check has a chance.
		await Promise.resolve();
		try {
			while (this.queue.length > 0) {
				const tid = this.queue.shift()!;
				this.pending.delete(tid);
				await this.runner(tid);
			}
		} finally {
			this.active = false;
		}
	}

	async drain(): Promise<void> {
		while (this.active || this.queue.length > 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
	}
}
