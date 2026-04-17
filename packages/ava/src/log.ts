type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.AVA_LOG_LEVEL ?? "info") as Level];

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
	if (order[level] < threshold) return;
	const line = {
		t: new Date().toISOString(),
		level,
		msg,
		...(meta ?? {}),
	};
	const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
	stream.write(JSON.stringify(line) + "\n");
}

export const log = {
	debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
	info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
	warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
	error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
