import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { estimateUsdCost } from "./backends/usage.js";
import { log } from "./log.js";

const execFileP = promisify(execFile);

/**
 * Local-only Kanban dashboard for Ava threads. Reads log.jsonl files
 * directly (no new infra), shows each thread as a card in the column
 * matching its state, lets you retry from the UI (writes a marker to
 * data/retry-queue/ — same mechanism as the thread-ops skill and the
 * auto-retry loop). Read-mostly; the only write action is "retry."
 *
 * Deliberate simplifications:
 *   - No auth. Bind address defaults to 127.0.0.1.
 *   - No websockets. Frontend polls /api/overview every 5s.
 *   - No build step. HTML/CSS/JS are embedded and served inline.
 *   - GitHub PR state is fetched lazily via `gh pr view` on detail
 *     request, cached ~60s in memory. Avoids hammering GH on the
 *     overview list (could be 20+ PRs).
 */

export interface WebUiDeps {
	dataDir: string;
	host: string;
	port: number;
	signal: AbortSignal;
}

interface LogRow {
	kind?: string;
	at?: string;
	gmailMessageId?: string;
	from?: string;
	subject?: string;
	bodyText?: string;
	category?: string;
	reason?: string;
	route?: string;
	confidence?: string;
	inReplyToMessageId?: string;
	backendUsed?: string;
	contract?: {
		status?: string;
		summary?: string;
		actionCount?: number;
		actionKinds?: string[];
		unfinishedCount?: number;
	};
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreateTokens: number;
		turnCount: number;
		durationMs: number;
	};
}

type ThreadState =
	| "failure" // latest event is a `failure` row with no subsequent retry/reply — needs attention
	| "blocked" // latest outbound contract.status === "blocked"
	| "partial" // latest outbound was partial OR done with 0 actions (hallucination pattern)
	| "pr_open" // thread produced a PR (action kind pr_opened) and it's still open
	| "active" // recent activity, agent replied with status=done+actions within 72h
	| "idle"; // >72h since last real activity

interface ThreadSummary {
	tid: string;
	state: ThreadState;
	subject: string;
	latestSender: string;
	latestAt: string; // ISO
	ageSeconds: number;
	messageCount: number;
	latestOutbound?: {
		status?: string;
		summary?: string;
		actionCount: number;
		actionKinds: string[];
		at: string;
		usdCost?: number;
	};
	latestFailure?: {
		category?: string;
		reason?: string;
		at: string;
	};
	prNumbers: number[]; // every pr_opened seen across outbound history
	inFlight: boolean; // true if a claude/codex process is currently running on this tid (checked via ps)
}

interface DaemonStatus {
	pid: number | null;
	startedAt: string | null;
	uptimeSeconds: number | null;
	inFlightThreads: string[]; // tids currently being processed
}

interface OverviewResponse {
	now: string;
	daemon: DaemonStatus;
	threads: ThreadSummary[];
}

export async function runWebUi(deps: WebUiDeps): Promise<void> {
	const server = createServer(async (req, res) => {
		try {
			await handleRequest(req, res, deps);
		} catch (e) {
			log.error("web-ui handler threw", { error: String(e), url: req.url });
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(`Internal error: ${String(e)}`);
			}
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(deps.port, deps.host, () => {
			log.info("web-ui listening", { url: `http://${deps.host}:${deps.port}` });
			resolve();
		});
	});
	await new Promise<void>((resolve) => {
		if (deps.signal.aborted) {
			resolve();
			return;
		}
		deps.signal.addEventListener(
			"abort",
			() => {
				server.close(() => resolve());
			},
			{ once: true },
		);
	});
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: WebUiDeps): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const path = url.pathname;
	if (req.method === "GET" && (path === "/" || path === "/index.html")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(renderIndexHtml());
		return;
	}
	if (req.method === "GET" && path === "/api/overview") {
		const overview = await buildOverview(deps.dataDir);
		jsonReply(res, 200, overview);
		return;
	}
	if (req.method === "GET" && path.startsWith("/api/threads/")) {
		const tid = path.slice("/api/threads/".length).split("/")[0];
		if (!tid || !/^[0-9a-z-]{3,}$/i.test(tid)) {
			jsonReply(res, 400, { error: "invalid thread id" });
			return;
		}
		if (path.endsWith("/pr-checks")) {
			const info = await fetchPrInfoForThread(deps.dataDir, tid);
			jsonReply(res, 200, info);
			return;
		}
		const detail = await buildThreadDetail(deps.dataDir, tid);
		if (!detail) {
			jsonReply(res, 404, { error: "thread not found" });
			return;
		}
		jsonReply(res, 200, detail);
		return;
	}
	if (req.method === "POST" && path.match(/^\/api\/threads\/[^/]+\/retry$/)) {
		const tid = path.split("/")[3];
		if (!/^[0-9a-z-]{3,}$/i.test(tid)) {
			jsonReply(res, 400, { error: "invalid thread id" });
			return;
		}
		const threadDir = join(deps.dataDir, "threads", tid);
		if (!existsSync(join(threadDir, "log.jsonl"))) {
			jsonReply(res, 404, { error: "thread not found" });
			return;
		}
		const queueDir = join(deps.dataDir, "retry-queue");
		await mkdir(queueDir, { recursive: true });
		const body = await readRequestBody(req).catch(() => "");
		let reason = "retry requested from web UI";
		try {
			const parsed = JSON.parse(body || "{}") as { reason?: string };
			if (parsed.reason && typeof parsed.reason === "string") reason = parsed.reason;
		} catch {
			/* empty/invalid body is fine */
		}
		await writeFile(join(queueDir, `${tid}.json`), JSON.stringify({ reason }));
		log.info("web-ui: retry marker dropped", { tid, reason });
		jsonReply(res, 202, { queued: true, tid });
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("not found");
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

// ----- overview builder -----

async function buildOverview(dataDir: string): Promise<OverviewResponse> {
	const threadsRoot = join(dataDir, "threads");
	const threads: ThreadSummary[] = [];
	if (existsSync(threadsRoot)) {
		const entries = (await readdir(threadsRoot, { withFileTypes: true })).filter(
			(e) => e.isDirectory() && !e.name.startsWith("sched-"),
		);
		const inFlight = await detectInFlightThreads();
		for (const e of entries) {
			try {
				const s = await summarizeThread(dataDir, e.name, inFlight);
				if (s) threads.push(s);
			} catch (err) {
				log.warn("web-ui overview: thread summarize failed", { tid: e.name, error: String(err) });
			}
		}
	}
	threads.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
	return { now: new Date().toISOString(), daemon: await daemonStatus(), threads };
}

async function summarizeThread(dataDir: string, tid: string, inFlightTids: Set<string>): Promise<ThreadSummary | null> {
	const logPath = join(dataDir, "threads", tid, "log.jsonl");
	if (!existsSync(logPath)) return null;
	const rows = parseLog(await readFile(logPath, "utf-8"));
	if (rows.length === 0) return null;

	let latestInbound: LogRow | null = null;
	let latestOutbound: LogRow | null = null;
	let latestFailure: LogRow | null = null;
	let firstInboundSubject = "";
	const prNumbers = new Set<number>();
	let messageCount = 0;
	for (const r of rows) {
		if (r.kind === "inbound") {
			messageCount++;
			latestInbound = r;
			if (!firstInboundSubject) firstInboundSubject = r.subject ?? "";
		} else if (r.kind === "outbound") {
			messageCount++;
			latestOutbound = r;
			// Extract PR numbers from outbound action kinds (summary field
			// only has kinds, not details, so we conservatively check for
			// any pr_opened kind present — the detail view shows which PR).
			const kinds = r.contract?.actionKinds ?? [];
			if (kinds.includes("pr_opened") || kinds.includes("pr_updated")) {
				// Can't extract number from summary — caller can open detail to find it.
			}
		} else if (r.kind === "failure") {
			latestFailure = r;
		}
	}

	// A more reliable PR number extraction: parse the Claude session for pr_opened
	// actions. Too heavy for the overview — defer to detail view. For overview
	// we just set a flag if kinds indicate any PR activity.
	const hasPr = (latestOutbound?.contract?.actionKinds ?? []).some((k) => k === "pr_opened" || k === "pr_updated");

	// Latest event (any kind)
	const latestRow = rows[rows.length - 1];
	const latestAt = latestRow.at ?? new Date().toISOString();
	const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(latestAt)) / 1000));

	const subject = (firstInboundSubject || latestInbound?.subject || "(no subject)").trim();
	const latestSender = latestInbound?.from ?? "(unknown)";

	const state = classifyThread({ rows, latestOutbound, latestFailure, latestInbound, hasPr, ageSeconds });

	const outSummary: ThreadSummary["latestOutbound"] = latestOutbound
		? {
				status: latestOutbound.contract?.status,
				summary: latestOutbound.contract?.summary,
				actionCount: latestOutbound.contract?.actionCount ?? 0,
				actionKinds: latestOutbound.contract?.actionKinds ?? [],
				at: latestOutbound.at ?? "",
				usdCost: latestOutbound.usage ? estimateUsdCost(latestOutbound.usage) : undefined,
			}
		: undefined;

	return {
		tid,
		state,
		subject,
		latestSender,
		latestAt,
		ageSeconds,
		messageCount,
		latestOutbound: outSummary,
		latestFailure: latestFailure
			? { category: latestFailure.category, reason: latestFailure.reason, at: latestFailure.at ?? "" }
			: undefined,
		prNumbers: Array.from(prNumbers),
		inFlight: inFlightTids.has(tid),
	};
}

function classifyThread(input: {
	rows: LogRow[];
	latestOutbound: LogRow | null;
	latestFailure: LogRow | null;
	latestInbound: LogRow | null;
	hasPr: boolean;
	ageSeconds: number;
}): ThreadState {
	const { rows, latestOutbound, latestFailure, hasPr, ageSeconds } = input;

	// If the newest event is a failure with no subsequent outbound or real
	// human inbound, it's a failure-in-state. Walk from the end.
	if (latestFailure) {
		const failureIdx = rows.lastIndexOf(latestFailure);
		let movedOn = false;
		for (let i = failureIdx + 1; i < rows.length; i++) {
			const r = rows[i];
			if (r.kind === "outbound") {
				movedOn = true;
				break;
			}
			if (r.kind === "inbound") {
				const msgId = r.gmailMessageId ?? "";
				if (!(msgId.startsWith("<retry-") && msgId.endsWith("@ava.local>"))) {
					movedOn = true;
					break;
				}
			}
		}
		if (!movedOn) return "failure";
	}

	const status = latestOutbound?.contract?.status;
	const actionCount = latestOutbound?.contract?.actionCount ?? 0;
	if (status === "blocked") return "blocked";
	if (status === "partial") return "partial";
	if (status === "done" && actionCount === 0) return "partial"; // hallucination pattern

	if (hasPr) return "pr_open";

	if (ageSeconds > 72 * 3600) return "idle";
	return "active";
}

function parseLog(text: string): LogRow[] {
	const rows: LogRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			/* skip malformed line */
		}
	}
	return rows;
}

// ----- daemon status -----

async function daemonStatus(): Promise<DaemonStatus> {
	try {
		const { stdout } = await execFileP("pgrep", ["-f", "node.*packages/ava/dist/main"]);
		const pids = stdout
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.map(Number)
			.filter((n) => Number.isFinite(n));
		if (pids.length === 0) return emptyDaemon();
		// Pick the most recently-started (highest pid is a rough proxy)
		const pid = Math.max(...pids);
		let startedAt: string | null = null;
		try {
			const { stdout: stat } = await execFileP("ps", ["-p", String(pid), "-o", "lstart="]);
			const raw = stat.trim();
			const d = new Date(raw);
			if (!Number.isNaN(d.getTime())) startedAt = d.toISOString();
		} catch {
			/* empty */
		}
		const uptimeSeconds = startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null;
		return { pid, startedAt, uptimeSeconds, inFlightThreads: [...(await detectInFlightThreads())] };
	} catch {
		return emptyDaemon();
	}
}

function emptyDaemon(): DaemonStatus {
	return { pid: null, startedAt: null, uptimeSeconds: null, inFlightThreads: [] };
}

async function detectInFlightThreads(): Promise<Set<string>> {
	// `docker exec ava-sandbox pgrep -fa 'claude|codex'` — extract tid from cwd arg
	const result = new Set<string>();
	try {
		const { stdout } = await execFileP("docker", ["exec", "ava-sandbox", "pgrep", "-fa", "claude|codex"]);
		for (const line of stdout.split("\n")) {
			const m = /\/workspace\/threads\/([0-9a-z-]+)\/worktree/i.exec(line);
			if (m) result.add(m[1]);
		}
	} catch {
		// container not running or pgrep unavailable — fine, return empty
	}
	return result;
}

// ----- thread detail -----

interface ThreadDetail {
	tid: string;
	summary: ThreadSummary;
	events: LogRow[];
}

async function buildThreadDetail(dataDir: string, tid: string): Promise<ThreadDetail | null> {
	const logPath = join(dataDir, "threads", tid, "log.jsonl");
	if (!existsSync(logPath)) return null;
	const rows = parseLog(await readFile(logPath, "utf-8"));
	const inFlight = await detectInFlightThreads();
	const summary = await summarizeThread(dataDir, tid, inFlight);
	if (!summary) return null;
	return { tid, summary, events: rows };
}

// ----- PR info (lazy, cached) -----

interface PrInfoCacheEntry {
	fetchedAt: number;
	data: unknown;
}
const prInfoCache = new Map<string, PrInfoCacheEntry>();
const PR_CACHE_TTL_MS = 60_000;

async function fetchPrInfoForThread(dataDir: string, tid: string): Promise<unknown> {
	const cached = prInfoCache.get(tid);
	if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return cached.data;
	const logPath = join(dataDir, "threads", tid, "log.jsonl");
	if (!existsSync(logPath)) return { prs: [] };

	// Extract PR numbers by grepping the agent's email_body in the Claude session
	// transcripts (our log.jsonl only records kinds + counts, not numbers).
	// Cheap heuristic: find "PR #NNN" or "pull/NNN" references in outbound
	// email bodies stored in the sandbox session jsonl.
	const prs = await extractPrNumbersFromSession(tid);
	if (prs.length === 0) {
		const result = { prs: [] };
		prInfoCache.set(tid, { fetchedAt: Date.now(), data: result });
		return result;
	}

	const infos: Array<{
		number: number;
		state: string;
		title: string;
		url: string;
		checks: Array<{ name: string; state: string }>;
	}> = [];
	const token = await readAvaGhToken();
	for (const n of prs) {
		try {
			const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
			const { stdout } = await execFileP(
				"gh",
				[
					"pr",
					"view",
					String(n),
					"--repo",
					"SmartAI/voicepulse",
					"--json",
					"number,title,state,url,statusCheckRollup",
				],
				{ env },
			);
			const obj = JSON.parse(stdout) as {
				number: number;
				title: string;
				state: string;
				url: string;
				statusCheckRollup?: Array<{ name?: string; context?: string; state?: string; conclusion?: string }>;
			};
			infos.push({
				number: obj.number,
				state: obj.state,
				title: obj.title,
				url: obj.url,
				checks: (obj.statusCheckRollup ?? []).map((c) => ({
					name: c.name ?? c.context ?? "unnamed",
					state: c.conclusion ?? c.state ?? "?",
				})),
			});
		} catch {
			infos.push({ number: n, state: "unknown", title: "(fetch failed)", url: "", checks: [] });
		}
	}
	const result = { prs: infos };
	prInfoCache.set(tid, { fetchedAt: Date.now(), data: result });
	return result;
}

async function extractPrNumbersFromSession(tid: string): Promise<number[]> {
	// Look at the claude session transcript for this thread and scan the last
	// few assistant messages for PR number references. Much cheaper than
	// loading the full transcript every time, and good enough for a dashboard.
	const sidPath = join("/home/mliu/Workspace/pi-mono/data/threads", tid, "claude-session-id");
	if (!existsSync(sidPath)) return [];
	const sid = readFileSync(sidPath, "utf-8").trim();
	const transcriptPath = join("/home/mliu/.claude/projects", `-workspace-threads-${tid}-worktree`, `${sid}.jsonl`);
	if (!existsSync(transcriptPath)) return [];
	let text: string;
	try {
		text = await readFile(transcriptPath, "utf-8");
	} catch {
		return [];
	}
	// Scan whole transcript for github.com/.../pull/NNN references
	const found = new Set<number>();
	for (const m of text.matchAll(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g)) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) found.add(n);
	}
	for (const m of text.matchAll(/"pr_opened"[^}]*?"number"\s*:\s*(\d+)/g)) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) found.add(n);
	}
	return Array.from(found).sort((a, b) => a - b);
}

async function readAvaGhToken(): Promise<string | null> {
	const p = `${process.env.HOME}/.config/ava/gh-token`;
	if (!existsSync(p)) return null;
	try {
		return (await readFile(p, "utf-8")).trim();
	} catch {
		return null;
	}
}

// ----- frontend -----

function renderIndexHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ava — Thread Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .kanban-col { min-width: 320px; max-width: 380px; }
  .card { transition: transform .08s ease-out, box-shadow .12s ease-out; }
  .card:hover { transform: translateY(-1px); box-shadow: 0 6px 14px rgba(0,0,0,.08); }
  .state-failure  { background: #fef2f2; border-left: 4px solid #dc2626; }
  .state-blocked  { background: #fefce8; border-left: 4px solid #ca8a04; }
  .state-partial  { background: #fff7ed; border-left: 4px solid #ea580c; }
  .state-pr_open  { background: #eff6ff; border-left: 4px solid #2563eb; }
  .state-active   { background: #f0fdf4; border-left: 4px solid #16a34a; }
  .state-idle     { background: #f9fafb; border-left: 4px solid #9ca3af; }
  .event-inbound  { border-left: 3px solid #6b7280; padding-left: .75rem; }
  .event-outbound { border-left: 3px solid #16a34a; padding-left: .75rem; }
  .event-failure  { border-left: 3px solid #dc2626; padding-left: .75rem; background: #fef2f2; }
  .event-triage   { border-left: 3px solid #8b5cf6; padding-left: .75rem; font-size: .9em; color: #6b7280; }
</style>
</head>
<body class="bg-gray-100 min-h-screen">

<header class="bg-white shadow-sm border-b">
  <div class="max-w-full px-6 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h1 class="text-lg font-semibold">Ava — Thread Dashboard</h1>
      <span id="daemon-status" class="text-sm text-gray-500"></span>
    </div>
    <div class="text-xs text-gray-400">
      Auto-refresh every 5s · last update <span id="last-update">—</span>
    </div>
  </div>
</header>

<main class="p-6">
  <div id="kanban" class="flex gap-4 overflow-x-auto pb-4"></div>
</main>

<!-- Detail modal -->
<div id="detail-modal" class="fixed inset-0 bg-black/40 hidden z-50" onclick="if(event.target===this) closeDetail()">
  <div class="bg-white max-w-4xl mx-auto my-10 rounded-lg shadow-xl max-h-[85vh] overflow-y-auto">
    <div class="sticky top-0 bg-white border-b px-6 py-3 flex items-center justify-between">
      <h2 id="detail-title" class="font-semibold"></h2>
      <button class="text-gray-400 hover:text-gray-700 text-xl" onclick="closeDetail()">×</button>
    </div>
    <div id="detail-body" class="px-6 py-4 text-sm"></div>
  </div>
</div>

<script>
const STATE_COLS = [
  { id: 'failure', label: 'Needs Attention (failures)', emoji: '🔧' },
  { id: 'blocked', label: 'Blocked on You', emoji: '⏸' },
  { id: 'partial', label: 'Partial / Hallucinated', emoji: '◐' },
  { id: 'pr_open', label: 'PR Open', emoji: '⛓' },
  { id: 'active',  label: 'Active', emoji: '✓' },
  { id: 'idle',    label: 'Idle (>72h)', emoji: '🌫' },
];

function relTime(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s/60) + 'm';
  if (s < 86400) return Math.round(s/3600) + 'h';
  return Math.round(s/86400) + 'd';
}

function fmtUsd(n) {
  if (n === undefined || n === null) return '';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

async function refresh() {
  try {
    const r = await fetch('/api/overview');
    const d = await r.json();
    renderOverview(d);
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

function renderOverview(data) {
  const daemon = data.daemon;
  const d = document.getElementById('daemon-status');
  if (daemon.pid) {
    const up = daemon.uptimeSeconds
      ? (daemon.uptimeSeconds > 3600 ? (daemon.uptimeSeconds/3600).toFixed(1)+'h' : Math.round(daemon.uptimeSeconds/60)+'m')
      : '?';
    d.innerHTML = '<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500"></span>daemon pid '+daemon.pid+' · up '+up+' · '+(daemon.inFlightThreads.length)+' in-flight</span>';
  } else {
    d.innerHTML = '<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-red-500"></span>daemon not running</span>';
  }

  const byState = new Map();
  for (const c of STATE_COLS) byState.set(c.id, []);
  for (const t of data.threads) {
    if (byState.has(t.state)) byState.get(t.state).push(t);
  }

  const kanban = document.getElementById('kanban');
  kanban.innerHTML = '';
  for (const col of STATE_COLS) {
    const threads = byState.get(col.id) || [];
    const colEl = document.createElement('div');
    colEl.className = 'kanban-col bg-white rounded-lg shadow-sm flex flex-col';
    colEl.innerHTML = '<div class="px-3 py-2 border-b bg-gray-50 rounded-t-lg flex items-center justify-between"><div class="font-medium text-sm">'+col.emoji+' '+col.label+'</div><span class="text-xs text-gray-400">'+threads.length+'</span></div>';
    const body = document.createElement('div');
    body.className = 'p-2 space-y-2 overflow-y-auto max-h-[75vh]';
    if (threads.length === 0) {
      body.innerHTML = '<div class="text-xs text-gray-400 p-2">empty</div>';
    } else {
      for (const t of threads) {
        const card = document.createElement('div');
        card.className = 'card state-'+t.state+' p-3 rounded cursor-pointer';
        const prBadge = (t.latestOutbound?.actionKinds || []).includes('pr_opened') ? '<span class="inline-block text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 mr-1">PR</span>' : '';
        const inFlight = t.inFlight ? '<span class="inline-block text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 ml-1 animate-pulse">in-flight</span>' : '';
        const cost = t.latestOutbound?.usdCost !== undefined ? '<span class="text-gray-400 text-xs">'+fmtUsd(t.latestOutbound.usdCost)+'</span>' : '';
        let detail = '';
        if (t.state === 'failure' && t.latestFailure) {
          detail = '<div class="text-xs text-red-700 mt-1">'+escapeHtml(t.latestFailure.reason || 'failure')+'</div>';
        } else if (t.state === 'blocked' || t.state === 'partial') {
          detail = t.latestOutbound?.summary ? '<div class="text-xs text-gray-600 mt-1">'+escapeHtml(t.latestOutbound.summary)+'</div>' : '';
        }
        const actions = t.latestOutbound?.actionKinds?.length ? '<span class="text-xs text-gray-500">'+t.latestOutbound.actionCount+' actions: '+t.latestOutbound.actionKinds.join(', ')+'</span>' : '';
        card.innerHTML =
          '<div class="font-medium text-sm line-clamp-2" title="'+escapeHtml(t.subject)+'">'+escapeHtml(t.subject)+'</div>' +
          '<div class="flex items-center gap-1 mt-1 flex-wrap">' + prBadge + inFlight +
          '<span class="text-xs text-gray-500">'+escapeHtml(t.latestSender.split('@')[0])+' · '+relTime(t.latestAt)+' ago</span>' + '</div>' +
          detail +
          '<div class="flex items-center justify-between mt-2">' + actions + cost + '</div>' +
          '<div class="mt-2 flex gap-2">' +
            '<button class="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200" onclick="event.stopPropagation(); showDetail(\\''+t.tid+'\\')">details</button>' +
            (t.state === 'failure' || t.state === 'blocked' ? '<button class="text-xs px-2 py-1 rounded bg-gray-200 hover:bg-gray-300" onclick="event.stopPropagation(); retry(\\''+t.tid+'\\')">retry</button>' : '') +
          '</div>';
        card.onclick = () => showDetail(t.tid);
        body.appendChild(card);
      }
    }
    colEl.appendChild(body);
    kanban.appendChild(colEl);
  }
}

async function showDetail(tid) {
  document.getElementById('detail-title').textContent = 'Thread ' + tid;
  document.getElementById('detail-body').innerHTML = '<div class="text-gray-500">Loading...</div>';
  document.getElementById('detail-modal').classList.remove('hidden');
  try {
    const r = await fetch('/api/threads/' + tid);
    const d = await r.json();
    document.getElementById('detail-title').textContent = d.summary.subject;
    let html = '<div class="space-y-3">';
    html += '<div class="text-xs text-gray-500">' + d.events.length + ' events · state: ' + d.summary.state + ' · last activity ' + relTime(d.summary.latestAt) + ' ago</div>';
    html += '<div class="space-y-2">';
    for (const e of d.events) {
      const ts = e.at ? new Date(e.at).toLocaleTimeString() : '';
      if (e.kind === 'inbound') {
        const isSynth = (e.gmailMessageId||'').startsWith('<retry-');
        html += '<div class="event-inbound py-2"><div class="text-xs text-gray-500">'+ts+' — IN from '+escapeHtml(e.from||'?')+(isSynth?' <span class="text-purple-600">[synthetic retry]</span>':'')+'</div><div class="text-sm">'+escapeHtml((e.bodyText||'').split('\\n').slice(0,2).join(' ').slice(0,300))+'</div></div>';
      } else if (e.kind === 'outbound') {
        const c = e.contract||{};
        const cost = e.usage ? ' · ~$'+estimateUsd(e.usage).toFixed(2) : '';
        html += '<div class="event-outbound py-2"><div class="text-xs text-gray-500">'+ts+' — OUT status=<b>'+(c.status||'?')+'</b> · '+(c.actionCount||0)+' actions ['+(c.actionKinds||[]).join(', ')+']'+cost+'</div><div class="text-sm">'+escapeHtml(c.summary||'(no summary)')+'</div></div>';
      } else if (e.kind === 'failure') {
        html += '<div class="event-failure py-2"><div class="text-xs text-red-700">'+ts+' — FAILURE ('+escapeHtml(e.category||'?')+')</div><div class="text-sm">'+escapeHtml(e.reason||'')+'</div></div>';
      } else if (e.kind === 'triage') {
        html += '<div class="event-triage py-1.5">'+ts+' — triage → <b>'+escapeHtml(e.route||'?')+'</b> ('+escapeHtml(e.confidence||'?')+')</div>';
      } else if (e.kind === 'allowlist-reject') {
        html += '<div class="event-failure py-1.5 text-xs">'+ts+' — allowlist rejected '+escapeHtml(e.from||'?')+' — '+escapeHtml(e.reason||'')+'</div>';
      }
    }
    html += '</div>';
    html += '<div class="border-t pt-3 mt-3"><div class="text-sm font-medium mb-2">PR status</div><div id="pr-status">Loading...</div></div>';
    html += '<div class="border-t pt-3 mt-3 flex gap-2">';
    if (d.summary.state === 'failure' || d.summary.state === 'blocked') {
      html += '<button class="px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700" onclick="retry(\\''+tid+'\\')">Retry thread</button>';
    }
    html += '<a class="px-3 py-1 text-sm rounded bg-gray-200 hover:bg-gray-300" target="_blank" href="https://mail.google.com/mail/u/0/#all/'+tid+'">Open in Gmail</a>';
    html += '</div>';
    html += '</div>';
    document.getElementById('detail-body').innerHTML = html;
    // Lazy-load PR info
    try {
      const pr = await fetch('/api/threads/'+tid+'/pr-checks').then(r=>r.json());
      const prEl = document.getElementById('pr-status');
      if (!pr.prs || pr.prs.length === 0) {
        prEl.innerHTML = '<div class="text-gray-500 text-sm">No PRs detected in this thread.</div>';
      } else {
        prEl.innerHTML = pr.prs.map(p => {
          const checksHtml = p.checks.map(c => {
            const cls = c.state === 'SUCCESS' ? 'bg-green-100 text-green-800' : c.state === 'FAILURE' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700';
            return '<span class="text-xs px-1.5 py-0.5 rounded '+cls+'">'+escapeHtml(c.name)+': '+escapeHtml(c.state)+'</span>';
          }).join(' ');
          return '<div class="mb-2"><a href="'+p.url+'" target="_blank" class="font-medium text-blue-600">PR #'+p.number+' — '+escapeHtml(p.title)+'</a> <span class="text-xs text-gray-500">['+p.state+']</span><div class="mt-1 flex flex-wrap gap-1">'+checksHtml+'</div></div>';
        }).join('');
      }
    } catch (e) {
      document.getElementById('pr-status').innerHTML = '<div class="text-red-600 text-sm">Failed to fetch PR status.</div>';
    }
  } catch (e) {
    document.getElementById('detail-body').innerHTML = '<div class="text-red-600">Failed to load thread: '+e+'</div>';
  }
}

function estimateUsd(u) {
  return (u.inputTokens*3 + u.outputTokens*15 + u.cacheReadTokens*0.3 + u.cacheCreateTokens*3.75) / 1_000_000;
}

function closeDetail() {
  document.getElementById('detail-modal').classList.add('hidden');
}

async function retry(tid) {
  if (!confirm('Queue retry for thread '+tid+'?')) return;
  const r = await fetch('/api/threads/'+tid+'/retry', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason: 'retry from web UI' }) });
  if (r.ok) {
    refresh();
    alert('Retry queued — the daemon will process it within ~30s.');
  } else {
    alert('Retry failed: ' + r.status);
  }
}

function escapeHtml(s) {
  return (s||'').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
