#!/usr/bin/env bun

import { AurionSession } from "../src/session";
import type { AurionAvailablePlanning } from "../src/promotions";
import type { AurionPlanningEvent } from "../src/types";

const DEFAULT_BASE_URL = "https://aurion.junia.com";
const DEFAULT_LEVELS = [1, 2, 3];
const REQUIRED_METHOD_COUNT = 13;

interface Config {
	baseUrl: string;
	username: string;
	password: string;
	levels: number[];
	taskCount: number;
	seed: number;
	window: { start: Date; end: Date };
}

interface RequestMetrics {
	requestCount: number;
	peakInFlight: number;
}

interface InstrumentedFetch {
	fetchFn: typeof fetch;
	reset(): void;
	metrics(): RequestMetrics;
}

interface PlanningReference {
	groupId: string;
	subgroupMenuId: string;
	planningMenuId: string;
	planningId: string;
	eventId: string;
}

interface PreparedSession {
	session: AurionSession;
	group: Awaited<ReturnType<AurionSession["getPlanningsGroups"]>>[number];
	subgroup: Awaited<ReturnType<AurionSession["getSubgroups"]>>[number];
	planning: AurionAvailablePlanning;
	event: AurionPlanningEvent;
	reference: PlanningReference;
	setupMs: number;
	setupRequests: number;
	setupPeakInFlight: number;
}

interface TaskSpec {
	method: string;
	run(): Promise<string>;
}

interface TaskResult {
	method: string;
	durationMs: number;
	fingerprint: string | null;
	error: string | null;
}

interface RunResult {
	level: number;
	setupMs: number;
	setupRequests: number;
	setupPeakInFlight: number;
	durationMs: number;
	requestCount: number;
	peakInFlight: number;
	taskResults: TaskResult[];
	matchedBaseline: number;
	errorCount: number;
}

function readConfig(): Config {
	const username = Bun.env.AURION_USERNAME;
	const password = Bun.env.AURION_PASSWORD;
	if (!username || !password) {
		throw new Error(
			"Set AURION_USERNAME and AURION_PASSWORD. See benchmark:parallelism in README.md.",
		);
	}

	const configuredLevels = (Bun.env.AURION_BENCH_CONCURRENCY_LEVELS ?? DEFAULT_LEVELS.join(","))
		.split(",")
		.map((value) => Number(value.trim()));
	if (
		configuredLevels.length === 0 ||
		configuredLevels.some((level) => !Number.isSafeInteger(level) || level < 1)
	) {
		throw new Error("AURION_BENCH_CONCURRENCY_LEVELS must contain positive safe integers.");
	}

	const taskCount = Number(Bun.env.AURION_BENCH_TASK_COUNT ?? 18);
	if (!Number.isInteger(taskCount) || taskCount < REQUIRED_METHOD_COUNT || taskCount > 40) {
		throw new Error(
			`AURION_BENCH_TASK_COUNT must be an integer from ${REQUIRED_METHOD_COUNT} to 40.`,
		);
	}

	const configuredSeed = Bun.env.AURION_BENCH_SEED;
	const seed = configuredSeed === undefined ? Date.now() >>> 0 : Number(configuredSeed);
	if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
		throw new Error("AURION_BENCH_SEED must be an integer from 0 to 4294967295.");
	}

	const start = Bun.env.AURION_BENCH_START
		? parseDate("AURION_BENCH_START", Bun.env.AURION_BENCH_START)
		: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const end = Bun.env.AURION_BENCH_END
		? parseDate("AURION_BENCH_END", Bun.env.AURION_BENCH_END)
		: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
	if (end <= start) {
		throw new Error("AURION_BENCH_END must be after AURION_BENCH_START.");
	}

	return {
		baseUrl: Bun.env.AURION_BASE_URL ?? DEFAULT_BASE_URL,
		username,
		password,
		levels: [...new Set([1, ...configuredLevels])].sort((a, b) => a - b),
		taskCount,
		seed,
		window: { start, end },
	};
}

function parseDate(name: string, value: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`${name} must be a valid date or ISO timestamp.`);
	}
	return date;
}

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function shuffle<T>(items: T[], random: () => number): T[] {
	const result = [...items];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const target = Math.floor(random() * (index + 1));
		[result[index], result[target]] = [result[target]!, result[index]!];
	}
	return result;
}

function createInstrumentedFetch(): InstrumentedFetch {
	let requestCount = 0;
	let inFlight = 0;
	let peakInFlight = 0;
	const handler = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		requestCount += 1;
		inFlight += 1;
		peakInFlight = Math.max(peakInFlight, inFlight);
		try {
			return await fetch(input, init);
		} finally {
			inFlight -= 1;
		}
	};

	return {
		fetchFn: Object.assign(handler, { preconnect: fetch.preconnect.bind(fetch) }),
		reset() {
			if (inFlight !== 0) {
				throw new Error("Cannot reset request metrics while HTTP requests are in flight.");
			}
			requestCount = 0;
			peakInFlight = 0;
		},
		metrics: () => ({ requestCount, peakInFlight }),
	};
}

function createSession(config: Config, fetchFn: typeof fetch): AurionSession {
	return new AurionSession({
		username: config.username,
		password: config.password,
		baseUrl: config.baseUrl,
		cache: false,
		fetchFn,
	});
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = Array.from<R>({ length: items.length });
	let nextIndex = 0;
	const workerCount = Math.min(limit, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await mapper(items[index]!, index);
			}
		}),
	);
	return results;
}

function asObject(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function fingerprint(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (!Array.isArray(item)) {
			return item;
		}
		return item.map((entry) => {
			const row = asObject(entry);
			if ("menuId" in row && "id" in row) {
				return [row.menuId, row.id, row.name];
			}
			if ("id" in row && "start" in row) {
				return [row.id, row.title, row.start, row.end];
			}
			if ("id" in row && "name" in row) {
				return [row.id, row.name];
			}
			if ("menuId" in row && "name" in row) {
				return [row.menuId, row.name];
			}
			return entry;
		});
	};
	const serialized = JSON.stringify(normalize(value)) ?? String(value);
	return `${serialized.length}:${Bun.hash(serialized)}`;
}

function errorLabel(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String(error.code);
	}
	return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function makeTask(method: string, action: () => Promise<unknown>): TaskSpec {
	return {
		method,
		async run() {
			return fingerprint(await action());
		},
	};
}

async function prepareSession(
	config: Config,
	fetchMetrics: InstrumentedFetch,
	reference?: PlanningReference,
): Promise<PreparedSession> {
	const session = createSession(config, fetchMetrics.fetchFn);
	const setupStartedAt = performance.now();
	const groups = await session.getPlanningsGroups();
	const availablePlannings = await session.getAllAvailablePlannings();
	const group = groups.find((item) => item.id === reference?.groupId) ?? groups[0];
	if (!group) {
		throw new Error("No promotion groups are visible to this Aurion account.");
	}

	const subgroups = await group.getSubgroups();
	const subgroup =
		subgroups.find((item) => item.menuId === reference?.subgroupMenuId) ?? subgroups[0];
	if (!subgroup) {
		throw new Error(`No subgroup is visible under group ${group.name}.`);
	}

	let planning = availablePlannings.find(
		(item) => item.menuId === reference?.planningMenuId && item.id === reference?.planningId,
	);
	let event: AurionPlanningEvent | undefined;
	if (planning) {
		const events = await planning.getPlanning(config.window);
		event = events.find((item) => item.id === reference?.eventId);
	} else {
		const distinctBranches = new Map<string, AurionAvailablePlanning>();
		for (const item of availablePlannings) {
			if (!distinctBranches.has(item.menuId)) {
				distinctBranches.set(item.menuId, item);
			}
		}
		const candidates = shuffle([...distinctBranches.values()], createRandom(config.seed + 41));
		for (const candidate of candidates.slice(0, 20)) {
			try {
				const events = await candidate.getPlanning(config.window);
				if (events.length > 0) {
					planning = candidate;
					event = events[0];
					break;
				}
			} catch {
				// Keep searching: one planning can fail transiently while other branches work.
			}
		}
	}
	if (!planning || !event) {
		throw new Error(
			"Could not find a planning event in the selected time window; configure AURION_BENCH_START/END.",
		);
	}

	const metrics = fetchMetrics.metrics();
	return {
		session,
		group,
		subgroup,
		planning,
		event,
		reference: {
			groupId: group.id,
			subgroupMenuId: subgroup.menuId,
			planningMenuId: planning.menuId,
			planningId: planning.id,
			eventId: event.id,
		},
		setupMs: performance.now() - setupStartedAt,
		setupRequests: metrics.requestCount,
		setupPeakInFlight: metrics.peakInFlight,
	};
}

function buildTasks(prepared: PreparedSession, config: Config, seed: number): TaskSpec[] {
	const { session, group, subgroup, planning, event } = prepared;
	const options = config.window;
	const required = [
		makeTask("AurionSession.getGrades", () => session.getGrades()),
		makeTask("AurionSession.getPlanning", () => session.getPlanning(options)),
		makeTask("AurionSession.getAbsences", () => session.getAbsences()),
		makeTask("AurionSession.getPlanningsGroups", () => session.getPlanningsGroups()),
		makeTask("AurionSession.getAllAvailablePlannings", () => session.getAllAvailablePlannings()),
		makeTask("AurionSession.getSubgroups", () => session.getSubgroups(group.id)),
		makeTask("AurionPlanningGroup.getSubgroups", () => group.getSubgroups()),
		makeTask("AurionSession.getAvailablePlannings", () =>
			session.getAvailablePlannings(subgroup.menuId),
		),
		makeTask("AurionPlanningSubgroup.getPlannings", () => subgroup.getPlannings()),
		makeTask("AurionSession.getPlanningForGroup", () =>
			session.getPlanningForGroup(planning.menuId, planning.id, options),
		),
		makeTask("AurionAvailablePlanning.getPlanning", () => planning.getPlanning(options)),
		makeTask("AurionSession.getEventDetails", () =>
			session.getEventDetails(event.id, { date: event.start }),
		),
		makeTask("AurionPlanningEvent.getDetails", () => event.getDetails()),
	];
	const random = createRandom(seed);
	const optionalRepeats = required.filter(
		(task) => task.method !== "AurionSession.getAllAvailablePlannings",
	);
	const tasks = [...required];
	while (tasks.length < config.taskCount) {
		const index = Math.floor(random() * optionalRepeats.length);
		const selected = optionalRepeats[index]!;
		tasks.push({
			method: `${selected.method}#repeat${tasks.length + 1}`,
			run: selected.run,
		});
	}
	return shuffle(tasks, random);
}

async function runLevel(
	config: Config,
	level: number,
	reference?: PlanningReference,
): Promise<{ result: RunResult; reference: PlanningReference; tasks: TaskSpec[] }> {
	const instrumented = createInstrumentedFetch();
	const prepared = await prepareSession(config, instrumented, reference);
	const tasks = buildTasks(prepared, config, config.seed);
	instrumented.reset();
	const startedAt = performance.now();
	const taskResults = await mapLimit(tasks, level, async (task): Promise<TaskResult> => {
		const taskStartedAt = performance.now();
		try {
			const result = await task.run();
			return {
				method: task.method,
				durationMs: performance.now() - taskStartedAt,
				fingerprint: result,
				error: null,
			};
		} catch (error: unknown) {
			return {
				method: task.method,
				durationMs: performance.now() - taskStartedAt,
				fingerprint: null,
				error: errorLabel(error),
			};
		}
	});
	const metrics = instrumented.metrics();
	return {
		result: {
			level,
			setupMs: prepared.setupMs,
			setupRequests: prepared.setupRequests,
			setupPeakInFlight: prepared.setupPeakInFlight,
			durationMs: performance.now() - startedAt,
			requestCount: metrics.requestCount,
			peakInFlight: metrics.peakInFlight,
			taskResults,
			matchedBaseline: 0,
			errorCount: taskResults.filter((item) => item.error !== null).length,
		},
		reference: prepared.reference,
		tasks,
	};
}

function printResults(results: RunResult[]): void {
	const baseline = results.find((item) => item.level === 1)!;
	for (const result of results) {
		result.matchedBaseline = result.taskResults.filter((item, index) => {
			const expected = baseline.taskResults[index];
			return (
				expected?.method === item.method &&
				expected.error === null &&
				item.error === null &&
				expected.fingerprint === item.fingerprint
			);
		}).length;
	}

	console.log("Mixed public-method workload:");
	console.table(
		results.map((result) => ({
			limit: result.level,
			setupSeconds: (result.setupMs / 1000).toFixed(2),
			setupRequests: result.setupRequests,
			setupPeakHttp: result.setupPeakInFlight,
			seconds: (result.durationMs / 1000).toFixed(2),
			tasksPerSecond: (result.taskResults.length / (result.durationMs / 1000)).toFixed(2),
			speedup: (baseline.durationMs / result.durationMs).toFixed(2),
			peakHttp: result.peakInFlight,
			requests: result.requestCount,
			tasks: result.taskResults.length,
			matchingBaseline: `${result.matchedBaseline}/${result.taskResults.length}`,
			errors: result.errorCount,
		})),
	);

	console.log("Per-method outcomes (fingerprints omit user data):");
	console.table(
		results.flatMap((result) =>
			result.taskResults.map((task) => ({
				limit: result.level,
				method: task.method,
				ms: task.durationMs.toFixed(0),
				status: task.error ? `ERROR: ${task.error}` : "ok",
			})),
		),
	);
}

async function main(): Promise<void> {
	const config = readConfig();
	console.log(`Aurion randomized concurrency benchmark: ${config.baseUrl}`);
	console.log(
		`Levels=${config.levels.join(",")}; tasks=${config.taskCount}; seed=${config.seed}; window=${config.window.start.toISOString()} -> ${config.window.end.toISOString()}`,
	);
	console.warn(
		"Live traffic on one JSF session; limits above 3 are exploratory. Stop if Aurion errors or results diverge.",
	);

	const results: RunResult[] = [];
	let reference: PlanningReference | undefined;
	for (const level of config.levels) {
		const run = await runLevel(config, level, reference);
		reference ??= run.reference;
		results.push(run.result);
	}
	printResults(results);
}

await main();
