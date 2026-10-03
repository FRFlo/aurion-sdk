import { describe, expect, test } from "bun:test";
import { InMemoryAurionCache } from "./cache";
import { createAurionError, isAurionError } from "./errors";
import { AurionSession } from "./session";
import { AurionTransport } from "./transport";

describe("AurionSession public API", () => {
	test("keeps structured errors while exposing an Error cause", () => {
		const cause = new Error("network failure");
		const error = createAurionError("AURION_TRANSPORT_ERROR", "Request failed", cause);

		expect(isAurionError(error)).toBe(true);
		expect(error.details).toBe(cause);
		expect(error.cause).toBe(cause);
	});

	test("keeps the password out of public properties", () => {
		const session = new AurionSession({ username: "demo", password: "secret" });

		expect(Object.keys(session)).not.toContain("password");
		expect("password" in session).toBe(false);
	});

	test("validates planning window ordering before making requests", async () => {
		const session = new AurionSession({ username: "demo", password: "secret" });

		await expect(
			session.getPlanning({
				start: new Date("2025-01-02T00:00:00.000Z"),
				end: new Date("2025-01-01T00:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(RangeError);
	});

	test("clearCache empties the configured shared store", async () => {
		const store = new InMemoryAurionCache();
		await store.set("shared", { kind: "value", value: "cached" });
		const session = new AurionSession({ username: "demo", password: "secret", cache: store });

		await session.clearCache();

		expect(await store.get("shared")).toBeUndefined();
	});

	test("lists plannings through the shorter alias", async () => {
		const session = new AurionSession({ username: "demo", password: "secret" });
		const plannings = [];
		session.getAllAvailablePlannings = async () => plannings;

		expect(await session.listAvailablePlannings()).toBe(plannings);
	});

	test("preserves native abort errors from the per-call signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const session = new AurionSession({
			username: "demo",
			password: "secret",
			fetchFn: Object.assign(async () => await new Promise<Response>(() => {}), {
				preconnect: fetch.preconnect.bind(fetch),
			}),
		});

		try {
			await session.getGrades({ signal: controller.signal });
			throw new Error("Expected the request to be aborted");
		} catch (error) {
			expect((error as Error).name).toBe("AbortError");
			expect(isAurionError(error)).toBe(false);
		}
	});

	test("passes a request-specific signal to fetch", async () => {
		const controller = new AbortController();
		const transport = new AurionTransport({
			username: "demo",
			password: "secret",
			baseUrl: "https://aurion.junia.com",
			cacheStore: null,
			fetchFn: Object.assign(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
							once: true,
						});
					}),
				{ preconnect: fetch.preconnect.bind(fetch) },
			),
		});
		const request = transport.request({ path: "/", cache: false, signal: controller.signal });
		controller.abort();

		await expect(request).rejects.toHaveProperty("name", "AbortError");
	});

	test("includes safe response context when authentication has no session cookie", async () => {
		const session = new AurionSession({
			username: "demo",
			password: "secret",
			fetchFn: Object.assign(
				async () => new Response(null, { status: 302, headers: { location: "/home" } }),
				{ preconnect: fetch.preconnect.bind(fetch) },
			),
		});

		await expect(session.getGrades()).rejects.toMatchObject({
			name: "AurionError",
			code: "AURION_AUTHENTICATION_ERROR",
			details: {
				status: 302,
				url: "https://aurion.junia.com/login",
				expected: "session cookie",
			},
		});
	});
});
