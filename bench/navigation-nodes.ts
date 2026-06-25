#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { AurionSession } from "../src/session";

const DEFAULT_BASE_URL = "https://aurion.junia.com";
const DEFAULT_ITERATIONS = 5;

interface RequestCounters {
	login: number;
	root: number;
	mainMenuGet: number;
	mainMenuPost: number;
	planningGet: number;
	planningPost: number;
	other: number;
}

type RequestTimingBucket = keyof RequestCounters;

interface TimingStats {
	count: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
}

type RequestTimings = Record<RequestTimingBucket, TimingStats>;

interface BenchmarkConfig {
	baseUrl: string;
	username: string;
	password: string;
	iterations: number;
	window: {
		start: Date;
		end: Date;
	};
}

interface BenchmarkResult {
	name: string;
	durationMs: number;
	counters: RequestCounters;
	timings: RequestTimings;
	treeRequestCount: number;
	reusableNavigationRequestCount: number;
}

function readConfig(): BenchmarkConfig {
	const username = Bun.env.AURION_USERNAME;
	const password = Bun.env.AURION_PASSWORD;

	if (!username || !password) {
		throw new Error(
			[
				"Missing real Aurion credentials.",
				"Run with environment variables, for example:",
				"  AURION_USERNAME=your-login AURION_PASSWORD=your-password bun run benchmark:navigation",
				"Optional variables: AURION_BASE_URL, AURION_BENCH_ITERATIONS, AURION_BENCH_START, AURION_BENCH_END.",
			].join("\n"),
		);
	}

	const iterations = Number(Bun.env.AURION_BENCH_ITERATIONS ?? DEFAULT_ITERATIONS);
	if (!Number.isInteger(iterations) || iterations < 2) {
		throw new Error("AURION_BENCH_ITERATIONS must be an integer greater than or equal to 2.");
	}

	return {
		baseUrl: Bun.env.AURION_BASE_URL ?? DEFAULT_BASE_URL,
		username,
		password,
		iterations,
		window: readPlanningWindow(),
	};
}

function readPlanningWindow(): { start: Date; end: Date } {
	const configuredStart = Bun.env.AURION_BENCH_START;
	const configuredEnd = Bun.env.AURION_BENCH_END;
	const start = configuredStart
		? parseDateEnvironmentValue("AURION_BENCH_START", configuredStart)
		: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const end = configuredEnd
		? parseDateEnvironmentValue("AURION_BENCH_END", configuredEnd)
		: new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);

	if (end.getTime() <= start.getTime()) {
		throw new Error("AURION_BENCH_END must be after AURION_BENCH_START.");
	}

	return { start, end };
}

function parseDateEnvironmentValue(name: string, value: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`${name} must be a valid date or ISO timestamp.`);
	}

	return date;
}

function createEmptyCounters(): RequestCounters {
	return {
		login: 0,
		root: 0,
		mainMenuGet: 0,
		mainMenuPost: 0,
		planningGet: 0,
		planningPost: 0,
		other: 0,
	};
}

function createEmptyTimings(): RequestTimings {
	return {
		login: createEmptyTimingStats(),
		root: createEmptyTimingStats(),
		mainMenuGet: createEmptyTimingStats(),
		mainMenuPost: createEmptyTimingStats(),
		planningGet: createEmptyTimingStats(),
		planningPost: createEmptyTimingStats(),
		other: createEmptyTimingStats(),
	};
}

function createEmptyTimingStats(): TimingStats {
	return {
		count: 0,
		totalMs: 0,
		minMs: Number.POSITIVE_INFINITY,
		maxMs: 0,
	};
}

function createInstrumentedFetch(baseUrl: string): {
	fetchFn: typeof fetch;
	counters: RequestCounters;
	timings: RequestTimings;
} {
	const counters = createEmptyCounters();
	const timings = createEmptyTimings();
	const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

	const handler = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");

		const bucket = countRequest(counters, normalizedBaseUrl, url, method);
		const startedAt = performance.now();

		try {
			return await fetch(input, init);
		} finally {
			recordTiming(timings[bucket], performance.now() - startedAt);
		}
	};

	return {
		fetchFn: Object.assign(handler, {
			preconnect: fetch.preconnect.bind(fetch),
		}),
		counters,
		timings,
	};
}

function countRequest(
	counters: RequestCounters,
	baseUrl: string,
	url: string,
	method: string,
): RequestTimingBucket {
	const pathname = url.startsWith(baseUrl)
		? url.slice(baseUrl.length) || "/"
		: new URL(url).pathname;

	if (pathname === "/login" && method === "POST") {
		counters.login += 1;
		return "login";
	}

	if (pathname === "/" && method === "GET") {
		counters.root += 1;
		return "root";
	}

	if (pathname === "/faces/MainMenuPage.xhtml" && method === "GET") {
		counters.mainMenuGet += 1;
		return "mainMenuGet";
	}

	if (pathname === "/faces/MainMenuPage.xhtml" && method === "POST") {
		counters.mainMenuPost += 1;
		return "mainMenuPost";
	}

	if (pathname === "/faces/Planning.xhtml" && method === "GET") {
		counters.planningGet += 1;
		return "planningGet";
	}

	if (pathname === "/faces/Planning.xhtml" && method === "POST") {
		counters.planningPost += 1;
		return "planningPost";
	}

	counters.other += 1;
	return "other";
}

function recordTiming(stats: TimingStats, durationMs: number): void {
	stats.count += 1;
	stats.totalMs += durationMs;
	stats.minMs = Math.min(stats.minMs, durationMs);
	stats.maxMs = Math.max(stats.maxMs, durationMs);
}

function createSession(config: BenchmarkConfig, fetchFn: typeof fetch): AurionSession {
	return new AurionSession({
		username: config.username,
		password: config.password,
		cache: false,
		baseUrl: config.baseUrl,
		fetchFn,
	});
}

function countTreeRequests(counters: RequestCounters): number {
	return counters.root + counters.mainMenuGet + counters.mainMenuPost + counters.planningGet;
}

function countReusableNavigationRequests(counters: RequestCounters): number {
	return counters.mainMenuGet + counters.mainMenuPost + counters.planningGet;
}

async function measure(
	name: string,
	counters: RequestCounters,
	timings: RequestTimings,
	action: () => Promise<void>,
): Promise<BenchmarkResult> {
	const startedAt = performance.now();
	await action();
	const durationMs = performance.now() - startedAt;

	return {
		name,
		durationMs,
		counters: { ...counters },
		timings: cloneTimings(timings),
		treeRequestCount: countTreeRequests(counters),
		reusableNavigationRequestCount: countReusableNavigationRequests(counters),
	};
}

function cloneTimings(timings: RequestTimings): RequestTimings {
	return {
		login: { ...timings.login },
		root: { ...timings.root },
		mainMenuGet: { ...timings.mainMenuGet },
		mainMenuPost: { ...timings.mainMenuPost },
		planningGet: { ...timings.planningGet },
		planningPost: { ...timings.planningPost },
		other: { ...timings.other },
	};
}

async function runColdTreeBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
	const instrumented = createInstrumentedFetch(config.baseUrl);

	return measure(
		"real Aurion cold tree rebuilt every call",
		instrumented.counters,
		instrumented.timings,
		async () => {
			for (let index = 0; index < config.iterations; index += 1) {
				const session = createSession(config, instrumented.fetchFn);
				await session.getPlanning(config.window);
			}
		},
	);
}

async function runWarmTreeBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
	const instrumented = createInstrumentedFetch(config.baseUrl);
	const session = createSession(config, instrumented.fetchFn);

	return measure(
		"real Aurion warm parent-child nodes reused",
		instrumented.counters,
		instrumented.timings,
		async () => {
			for (let index = 0; index < config.iterations; index += 1) {
				await session.getPlanning(config.window);
			}
		},
	);
}

async function assertNoCrossSessionCollision(config: BenchmarkConfig): Promise<void> {
	const first = createInstrumentedFetch(config.baseUrl);
	const second = createInstrumentedFetch(config.baseUrl);
	const firstSession = createSession(config, first.fetchFn);
	const secondSession = createSession(config, second.fetchFn);

	await firstSession.getPlanning(config.window);
	await secondSession.getPlanning(config.window);
	await firstSession.getPlanning(config.window);

	assert.equal(countReusableNavigationRequests(first.counters), 3);
	assert.equal(first.counters.planningPost, 2);
	assert.equal(countReusableNavigationRequests(second.counters), 3);
	assert.equal(second.counters.planningPost, 1);
}

function assertBenchmarkImproved(cold: BenchmarkResult, warm: BenchmarkResult): void {
	assert.equal(cold.reusableNavigationRequestCount, cold.counters.planningPost * 3);
	assert.equal(warm.reusableNavigationRequestCount, 3);
	assert.equal(warm.counters.planningPost, cold.counters.planningPost);
	assert.ok(
		warm.reusableNavigationRequestCount < cold.reusableNavigationRequestCount,
		`Expected warm reusable navigation requests (${warm.reusableNavigationRequestCount}) to be lower than cold reusable navigation requests (${cold.reusableNavigationRequestCount}).`,
	);
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function printResult(config: BenchmarkConfig, cold: BenchmarkResult, warm: BenchmarkResult): void {
	const treeRequestReduction = 1 - warm.treeRequestCount / cold.treeRequestCount;
	const durationReduction = 1 - warm.durationMs / cold.durationMs;

	console.log(`Real Aurion benchmark target: ${config.baseUrl}`);
	console.log(
		`Planning window: ${config.window.start.toISOString()} -> ${config.window.end.toISOString()}`,
	);
	console.table([
		{
			scenario: cold.name,
			durationMs: cold.durationMs.toFixed(2),
			treeRequests: cold.treeRequestCount,
			reusableNavigationRequests: cold.reusableNavigationRequestCount,
			planningRequests: cold.counters.planningPost,
			loginRequests: cold.counters.login,
		},
		{
			scenario: warm.name,
			durationMs: warm.durationMs.toFixed(2),
			treeRequests: warm.treeRequestCount,
			reusableNavigationRequests: warm.reusableNavigationRequestCount,
			planningRequests: warm.counters.planningPost,
			loginRequests: warm.counters.login,
		},
	]);

	console.log(
		`Navigation tree request reduction: ${formatPercent(treeRequestReduction)} (${cold.treeRequestCount} -> ${warm.treeRequestCount}).`,
	);
	console.log(
		`Reusable navigation request reduction: ${formatPercent(1 - warm.reusableNavigationRequestCount / cold.reusableNavigationRequestCount)} (${cold.reusableNavigationRequestCount} -> ${warm.reusableNavigationRequestCount}).`,
	);
	console.log(`Measured runtime delta on real Aurion: ${formatPercent(durationReduction)}.`);
	console.log("Per-request timing buckets (ms):");
	console.table(createTimingRows(cold, warm));
	console.log(
		"Collision check: passed; independent real sessions kept independent navigation trees.",
	);
}

function createTimingRows(
	cold: BenchmarkResult,
	warm: BenchmarkResult,
): Array<Record<string, string | number>> {
	const buckets: RequestTimingBucket[] = [
		"login",
		"root",
		"mainMenuGet",
		"mainMenuPost",
		"planningGet",
		"planningPost",
		"other",
	];

	return buckets.flatMap((bucket) => [
		createTimingRow(cold.name, bucket, cold.timings[bucket]),
		createTimingRow(warm.name, bucket, warm.timings[bucket]),
	]);
}

function createTimingRow(
	scenario: string,
	bucket: RequestTimingBucket,
	stats: TimingStats,
): Record<string, string | number> {
	const averageMs = stats.count === 0 ? 0 : stats.totalMs / stats.count;
	const minMs = stats.count === 0 ? 0 : stats.minMs;

	return {
		scenario,
		bucket,
		count: stats.count,
		totalMs: stats.totalMs.toFixed(2),
		avgMs: averageMs.toFixed(2),
		minMs: minMs.toFixed(2),
		maxMs: stats.maxMs.toFixed(2),
	};
}

const config = readConfig();
const cold = await runColdTreeBenchmark(config);
const warm = await runWarmTreeBenchmark(config);

assertBenchmarkImproved(cold, warm);
await assertNoCrossSessionCollision(config);
printResult(config, cold, warm);
