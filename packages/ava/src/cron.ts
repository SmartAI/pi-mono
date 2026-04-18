/**
 * Minimal 5-field crontab matcher. Fields: minute hour day-of-month month day-of-week.
 * Supports `*`, exact numbers, `a,b,c` lists, `a-b` ranges, `* /n` / `a-b/n` steps.
 * DOW is 0–6 with 0=Sunday (no aliases like "mon" — keep the grammar tight).
 */
export interface CronMatch {
	match(date: Date): boolean;
}

export function parseCron(expr: string): CronMatch {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Cron expression must have 5 fields (m h dom mon dow); got: ${expr}`);
	}
	const [mStr, hStr, domStr, monStr, dowStr] = parts;
	const minute = parseField(mStr, 0, 59);
	const hour = parseField(hStr, 0, 23);
	const dom = parseField(domStr, 1, 31);
	const month = parseField(monStr, 1, 12);
	const dow = parseField(dowStr, 0, 6);
	return {
		match(d: Date): boolean {
			return (
				minute.has(d.getMinutes()) &&
				hour.has(d.getHours()) &&
				dom.has(d.getDate()) &&
				month.has(d.getMonth() + 1) &&
				dow.has(d.getDay())
			);
		},
	};
}

function parseField(field: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) throw new Error(`empty field segment`);
		const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
		if (stepMatch) {
			const [, rangePart, stepStr] = stepMatch;
			const step = parseInt(stepStr, 10);
			if (!(step > 0)) throw new Error(`step must be > 0 in "${part}"`);
			const [lo, hi] = rangePart === "*" ? [min, max] : parseRange(rangePart, min, max);
			for (let i = lo; i <= hi; i += step) out.add(i);
			continue;
		}
		if (part === "*") {
			for (let i = min; i <= max; i++) out.add(i);
			continue;
		}
		const [lo, hi] = parseRange(part, min, max);
		for (let i = lo; i <= hi; i++) out.add(i);
	}
	return out;
}

function parseRange(s: string, min: number, max: number): [number, number] {
	const dash = s.indexOf("-");
	if (dash === -1) {
		const n = parseInt(s, 10);
		if (!Number.isFinite(n) || n < min || n > max) {
			throw new Error(`value ${s} out of range [${min},${max}]`);
		}
		return [n, n];
	}
	const lo = parseInt(s.slice(0, dash), 10);
	const hi = parseInt(s.slice(dash + 1), 10);
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
		throw new Error(`range ${s} out of bounds [${min},${max}]`);
	}
	return [lo, hi];
}
