import { describe, expect, test } from "bun:test";
import { createAurionCacheKey, InMemoryAurionCache } from "./cache";
import { AurionTransport } from "./transport";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(input instanceof Request ? input.url : String(input), init),
		{ preconnect: fetch.preconnect.bind(fetch) },
	);
}

function createTransport(options: Partial<ConstructorParameters<typeof AurionTransport>[0]> = {}) {
	return new AurionTransport({
		username: "demo",
		password: "secret",
		baseUrl: "https://aurion.test",
		cacheStore: null,
		...options,
	});
}

describe("AurionTransport resilience", () => {
	test("times out a stalled network request as a transport error", async () => {
		const transport = createTransport({
			requestTimeoutMs: 5,
			fetchFn: mockFetch(() => new Promise(() => {})),
		});

		await expect(transport.request({ path: "/stalled", cache: false })).rejects.toMatchObject({
			name: "AurionError",
			code: "AURION_TRANSPORT_ERROR",
			details: { timeoutMs: 5 },
		});
	});

	test("does not cache failed HTTP responses", async () => {
		let fetchCount = 0;
		const transport = createTransport({
			cacheStore: new InMemoryAurionCache(),
			fetchFn: mockFetch(async () => {
				fetchCount += 1;
				return new Response(fetchCount === 1 ? "temporary error" : "fresh", {
					status: fetchCount === 1 ? 500 : 200,
				});
			}),
		});

		const first = await transport.request({ path: "/resource" });
		const second = await transport.request({ path: "/resource" });

		expect(first.status).toBe(500);
		expect(second.body).toBe("fresh");
		expect(second.fromCache).toBe(false);
		expect(fetchCount).toBe(2);
	});

	test("keeps cached requests with different response headers separate", async () => {
		let fetchCount = 0;
		const transport = createTransport({
			cacheStore: new InMemoryAurionCache(),
			fetchFn: mockFetch(async (_url, init) => {
				fetchCount += 1;
				return new Response(new Headers(init?.headers).get("accept") ?? "missing");
			}),
		});

		const first = await transport.request({
			path: "/resource",
			headers: { Accept: "application/json" },
		});
		const second = await transport.request({
			path: "/resource",
			headers: { Accept: "text/plain" },
		});

		expect(first.body).toBe("application/json");
		expect(second.body).toBe("text/plain");
		expect(fetchCount).toBe(2);
	});

	test("deletes malformed cached transport entries and fetches a fresh response", async () => {
		const cacheStore = new InMemoryAurionCache();
		const cacheKey = createAurionCacheKey(
			"transport:demo",
			"GET",
			"https://aurion.test/resource",
			undefined,
			"follow:",
		);
		await cacheStore.set(cacheKey, { kind: "transport" } as never);
		let fetchCount = 0;
		const transport = createTransport({
			cacheStore,
			fetchFn: mockFetch(async () => {
				fetchCount += 1;
				return new Response("fresh");
			}),
		});

		const response = await transport.request({ path: "/resource" });

		expect(response.body).toBe("fresh");
		expect(response.fromCache).toBe(false);
		expect(fetchCount).toBe(1);
	});

	test("isolates shared transport cache entries by username", async () => {
		const cacheStore = new InMemoryAurionCache();
		const first = createTransport({
			username: "alice",
			cacheStore,
			fetchFn: mockFetch(async () => new Response("alice")),
		});
		const second = createTransport({
			username: "bob",
			cacheStore,
			fetchFn: mockFetch(async () => new Response("bob")),
		});

		expect((await first.request({ path: "/private" })).body).toBe("alice");
		const bob = await second.request({ path: "/private" });
		expect(bob.body).toBe("bob");
		expect(bob.fromCache).toBe(false);
	});

	test("strips sensitive caller headers across cross-origin redirects", async () => {
		const seenHeaders: Headers[] = [];
		const transport = createTransport({
			fetchFn: mockFetch(async (url, init) => {
				seenHeaders.push(new Headers(init?.headers));
				return url.endsWith("/start")
					? new Response(null, { status: 302, headers: { location: "https://other.test/end" } })
					: new Response("ok");
			}),
		});

		await transport.request({
			path: "/start",
			cache: false,
			headers: { Authorization: "Bearer private", Cookie: "session=private" },
		});

		expect(seenHeaders[0]?.get("authorization")).toBe("Bearer private");
		expect(seenHeaders[1]?.get("authorization")).toBeNull();
		expect(seenHeaders[1]?.get("cookie")).toBeNull();
	});

	test("does not treat 304 as a redirect even when it has Location", async () => {
		let fetchCount = 0;
		const transport = createTransport({
			fetchFn: mockFetch(async () => {
				fetchCount += 1;
				return new Response(null, { status: 304, headers: { location: "/other" } });
			}),
		});

		const response = await transport.request({ path: "/resource", cache: false });

		expect(response.status).toBe(304);
		expect(fetchCount).toBe(1);
	});

	test("reauthenticates once when a read is redirected to the login page", async () => {
		let loginCount = 0;
		let resourceCount = 0;
		const transport = createTransport({
			fetchFn: mockFetch(async (url, init) => {
				if (url.endsWith("/login")) {
					loginCount += 1;
					return new Response(null, {
						status: 302,
						headers: { "Set-Cookie": `JSESSIONID=session-${loginCount}; Path=/` },
					});
				}
				if (url.endsWith("/resource")) {
					resourceCount += 1;
					return resourceCount === 1
						? new Response(null, { status: 302, headers: { location: "/faces/Login.xhtml" } })
						: new Response("fresh data");
				}
				if (url.endsWith("/faces/Login.xhtml")) return new Response("login page");
				throw new Error(`Unexpected request ${init?.method} ${url}`);
			}),
		});

		await transport.login();
		const response = await transport.request({ path: "/resource", cache: false });

		expect(response.body).toBe("fresh data");
		expect(loginCount).toBe(2);
		expect(resourceCount).toBe(2);
	});

	test("deduplicates reauthentication for concurrent expired-session reads", async () => {
		let loginCount = 0;
		let resourceCount = 0;
		const transport = createTransport({
			fetchFn: mockFetch(async (url) => {
				if (url.endsWith("/login")) {
					loginCount += 1;
					return new Response(null, {
						status: 302,
						headers: { "Set-Cookie": `JSESSIONID=session-${loginCount}; Path=/` },
					});
				}
				if (url.endsWith("/resource-a") || url.endsWith("/resource-b")) {
					resourceCount += 1;
					return resourceCount <= 2
						? new Response(null, { status: 302, headers: { location: "/faces/Login.xhtml" } })
						: new Response(url.endsWith("/resource-a") ? "a" : "b");
				}
				if (url.endsWith("/faces/Login.xhtml")) return new Response("login page");
				throw new Error(`Unexpected request ${url}`);
			}),
		});

		await transport.login();
		const [first, second] = await Promise.all([
			transport.request({ path: "/resource-a", cache: false }),
			transport.request({ path: "/resource-b", cache: false }),
		]);

		expect([first.body, second.body]).toEqual(["a", "b"]);
		expect(loginCount).toBe(2);
		expect(resourceCount).toBe(4);
	});

	test("validates request timeout configuration", () => {
		expect(() => createTransport({ requestTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
			RangeError,
		);
	});
});
