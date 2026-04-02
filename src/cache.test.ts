import { describe, expect, test } from "bun:test";
import {
	type AurionCacheOptions,
	createAurionValueCacheKey,
	InMemoryAurionCache,
	resolveAurionCacheConfig,
	resolveAurionCacheStore,
} from "./cache";
import { AurionSession } from "./session";
import { AurionTransport } from "./transport";

function createMockFetch(
	handler: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, {
		preconnect: fetch.preconnect.bind(fetch),
	});
}

function createSession(
	cache: boolean | InMemoryAurionCache | AurionCacheOptions,
	options?: {
		username?: string;
		baseUrl?: string;
		fetchFn?: typeof fetch;
	},
): AurionSession {
	return new AurionSession({
		username: options?.username ?? "demo",
		password: "secret",
		cache,
		baseUrl: options?.baseUrl,
		fetchFn:
			options?.fetchFn ??
			createMockFetch(async () => {
				throw new Error("network should not be called when session cache is hit");
			}),
	});
}

async function seedSessionValue<TValue>(
	cacheStore: InMemoryAurionCache,
	parts: {
		baseUrl?: string;
		username?: string;
		resource: string;
		suffix?: string;
	},
	value: TValue,
	createdAt?: number,
): Promise<void> {
	const scope = `${parts.baseUrl ?? "https://aurion.junia.com"}:${parts.username ?? "demo"}`;
	const keySuffix = parts.suffix ? `:${parts.suffix}` : "";

	await cacheStore.set(createAurionValueCacheKey("session", `${scope}:${parts.resource}${keySuffix}`), {
		kind: "value",
		createdAt,
		value,
	});
}

describe("cache configuration", () => {
	test("resolveAurionCacheStore preserves booleans and custom stores", () => {
		const customStore = new InMemoryAurionCache();

		expect(resolveAurionCacheStore(false)).toBeNull();
		expect(resolveAurionCacheStore(true)).toBeInstanceOf(InMemoryAurionCache);
		expect(resolveAurionCacheStore(customStore)).toBe(customStore);
	});

	test("resolveAurionCacheConfig maps invalidation options", () => {
		const cacheStore = new InMemoryAurionCache();
		const cacheConfig = resolveAurionCacheConfig({
			store: cacheStore,
			maxAgeMs: 5_000,
			sessionMaxAgeMs: 1_000,
		});

		expect(cacheConfig.store).toBe(cacheStore);
		expect(cacheConfig.sessionMaxAgeMs).toBe(1_000);
		expect(cacheConfig.transportMaxAgeMs).toBe(5_000);
	});

		test("AurionSession uses preloaded cached grades before hitting the network", async () => {
			const cacheStore = new InMemoryAurionCache();
			const cachedGrades = [
			{
				date: new Date("2025-01-15T00:00:00.000Z"),
				code: "MATH101",
				name: "Algebra",
				grade: 18,
				coefficient: 2,
				average: 13,
				min: 6,
				max: 19,
				median: 13,
				standardDeviation: 2,
				comment: "cached",
			},
		];

		await seedSessionValue(cacheStore, { resource: "grades" }, cachedGrades, Date.now());

		const session = createSession(cacheStore);

		await expect(session.getGrades()).resolves.toEqual(cachedGrades);
	});

	test("AurionSession uses preloaded cached planning and absences before hitting the network", async () => {
		const cacheStore = new InMemoryAurionCache();
		const planningWindow = {
			start: new Date("2025-01-01T00:00:00.000Z"),
			end: new Date("2025-01-31T00:00:00.000Z"),
		};
		const cachedPlanning = [
			{
				id: "event-1",
				title: "Architecture",
				start: new Date("2025-01-15T08:00:00.000Z"),
				end: new Date("2025-01-15T10:00:00.000Z"),
				allDay: false,
				editable: false,
				type: "Cours",
			},
		];
		const cachedAbsences = [
			{
				date: new Date("2025-02-10T00:00:00.000Z"),
				type: "Justifiée",
				duration: "2h",
				time: new Date("2025-02-10T08:00:00.000Z"),
				class: "A1",
				teacher: "Mme Cache",
			},
		];

		await seedSessionValue(
			cacheStore,
			{
				resource: "planning",
				suffix: `${planningWindow.start.toISOString()}:${planningWindow.end.toISOString()}`,
			},
			cachedPlanning,
			Date.now(),
		);
		await seedSessionValue(cacheStore, { resource: "absences" }, cachedAbsences, Date.now());

		const session = createSession(cacheStore);

		await expect(session.getPlanning(planningWindow)).resolves.toEqual(cachedPlanning);
		await expect(session.getAbsences()).resolves.toEqual(cachedAbsences);
	});

	test("AurionSession cache keys include baseUrl to avoid collisions across instances", async () => {
		const cacheStore = new InMemoryAurionCache();
		let fetchCount = 0;
		const cachedGrades = [
			{
				date: new Date("2025-01-15T00:00:00.000Z"),
				code: "SAFE",
				name: "Instance specific",
				grade: 20,
				coefficient: 1,
				average: 12,
				min: 4,
				max: 20,
				median: 12,
				standardDeviation: 3,
				comment: null,
			},
		];

		await seedSessionValue(
			cacheStore,
			{ resource: "grades", baseUrl: "https://campus-a.test" },
			cachedGrades,
			Date.now(),
		);

		const session = createSession(cacheStore, {
			baseUrl: "https://campus-b.test",
			fetchFn: createMockFetch(async () => {
				fetchCount += 1;
				throw new Error("network should be attempted because the baseUrl-specific cache key differs");
			}),
		});

		await expect(session.getGrades()).rejects.toThrow("La requête réseau Aurion a échoué.");
		expect(fetchCount).toBe(1);
	});

	test("AurionSession supports built-in in-memory cache with cache=true", async () => {
		const session = createSession(true);

		expect(session.cache).toBe(true);
		expect(session.cacheStore).toBeInstanceOf(InMemoryAurionCache);
	});

	test("AurionSession invalidates expired session entries", async () => {
		const cacheStore = new InMemoryAurionCache();
		const expiredGrades = [
			{
				date: new Date("2025-01-15T00:00:00.000Z"),
				code: "OLD",
				name: "Expired",
				grade: 10,
				coefficient: 1,
				average: 10,
				min: 10,
				max: 10,
				median: 10,
				standardDeviation: 0,
				comment: null,
			},
		];

		await seedSessionValue(cacheStore, { resource: "grades" }, expiredGrades, Date.now() - 10_000);

		const session = createSession({
			store: cacheStore,
			sessionMaxAgeMs: 1,
		}, {
			fetchFn: createMockFetch(async () => {
				throw new Error("expired session cache should fall through to the network");
			}),
		});

		await expect(session.getGrades()).rejects.toThrow("La requête réseau Aurion a échoué.");
	});
});

describe("transport cache", () => {
		test("AurionTransport reads and writes through the injected cache store", async () => {
			const cacheStore = new InMemoryAurionCache();
			let fetchCount = 0;
			const fetchFn = createMockFetch(async () => {
				fetchCount += 1;
				return new Response("payload", {
					status: 200,
					headers: {
						"Content-Type": "text/plain",
					},
				});
			});

		const transport = new AurionTransport({
			username: "demo",
			password: "secret",
			baseUrl: "https://example.test",
			cacheStore,
			fetchFn,
		});

		const firstResponse = await transport.request({
			path: "/resource",
			method: "GET",
		});
		const secondResponse = await transport.request({
			path: "/resource",
			method: "GET",
		});

		expect(fetchCount).toBe(1);
		expect(firstResponse.fromCache).toBe(false);
		expect(secondResponse.fromCache).toBe(true);
		expect(secondResponse.body).toBe("payload");
	});

	test("AurionTransport invalidates expired transport entries", async () => {
		const cacheStore = new InMemoryAurionCache();
		let fetchCount = 0;
		const fetchFn = createMockFetch(async () => {
			fetchCount += 1;
			return new Response(`payload-${fetchCount}`, {
				status: 200,
				headers: {
					"Content-Type": "text/plain",
				},
			});
		});

		const transport = new AurionTransport({
			username: "demo",
			password: "secret",
			baseUrl: "https://example.test",
			cacheStore,
			cacheMaxAgeMs: 1,
			fetchFn,
		});

		await cacheStore.set("transport:GET:https://example.test/resource:", {
			kind: "transport",
			createdAt: Date.now() - 10_000,
			status: 200,
			initialStatus: 200,
			url: "https://example.test/resource",
			body: "stale",
			headers: [["content-type", "text/plain"]],
		});

		const response = await transport.request({
			path: "/resource",
			method: "GET",
		});

		expect(fetchCount).toBe(1);
		expect(response.fromCache).toBe(false);
		expect(response.body).toBe("payload-1");
	});
});
