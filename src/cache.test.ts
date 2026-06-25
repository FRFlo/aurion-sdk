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
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => Promise<Response>,
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

interface PlanningNavigationCounts {
	root: number;
	mainMenuGet: number;
	mainMenuPost: number;
	planningGet: number;
	planningPost: number;
}

function getPlanningCounts(
	countsBySession: Map<string, PlanningNavigationCounts>,
	sessionId: string,
): PlanningNavigationCounts {
	const existing = countsBySession.get(sessionId);
	if (existing) {
		return existing;
	}

	const counts = {
		root: 0,
		mainMenuGet: 0,
		mainMenuPost: 0,
		planningGet: 0,
		planningPost: 0,
	};
	countsBySession.set(sessionId, counts);

	return counts;
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

	await cacheStore.set(
		createAurionValueCacheKey("session", `${scope}:${parts.resource}${keySuffix}`),
		{
			kind: "value",
			createdAt,
			value,
		},
	);
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

	test("resolveAurionCacheConfig maps planning time range approximation", () => {
		const cacheConfig = resolveAurionCacheConfig({
			timeRangeApproximation: {
				planning: {
					unit: "minute",
					step: 15,
				},
			},
		});

		expect(cacheConfig.planningTimeRangeApproximationMs).toBe(900_000);
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

	test("AurionSession approximates planning windows for cache hits while preserving the exact returned range", async () => {
		const cacheStore = new InMemoryAurionCache();
		const requestedWindow = {
			start: new Date("2025-01-01T10:02:00.000Z"),
			end: new Date("2025-01-01T10:58:00.000Z"),
		};
		const approximatedWindow = {
			start: new Date("2025-01-01T10:00:00.000Z"),
			end: new Date("2025-01-01T11:00:00.000Z"),
		};
		const expectedPlanning = {
			id: "event-inside",
			title: "Inside",
			start: new Date("2025-01-01T10:15:00.000Z"),
			end: new Date("2025-01-01T10:45:00.000Z"),
			allDay: false,
			editable: false,
			type: "Cours",
		};
		const cachedPlanning = [
			{
				id: "event-before",
				title: "Before",
				start: new Date("2025-01-01T09:55:00.000Z"),
				end: new Date("2025-01-01T10:01:00.000Z"),
				allDay: false,
				editable: false,
				type: "Cours",
			},
			expectedPlanning,
			{
				id: "event-after",
				title: "After",
				start: new Date("2025-01-01T10:58:00.000Z"),
				end: new Date("2025-01-01T11:10:00.000Z"),
				allDay: false,
				editable: false,
				type: "Cours",
			},
		];

		await seedSessionValue(
			cacheStore,
			{
				resource: "planning",
				suffix: `${approximatedWindow.start.toISOString()}:${approximatedWindow.end.toISOString()}`,
			},
			cachedPlanning,
			Date.now(),
		);

		const session = createSession({
			store: cacheStore,
			timeRangeApproximation: {
				planning: {
					unit: "hour",
				},
			},
		});

		await expect(session.getPlanning(requestedWindow)).resolves.toEqual([expectedPlanning]);
	});

	test("AurionSession sends the approximated planning window in the network request", async () => {
		const requestedWindow = {
			start: new Date("2025-01-01T10:02:00.000Z"),
			end: new Date("2025-01-01T10:58:00.000Z"),
		};
		const capturedPlanningRequests: URLSearchParams[] = [];
		const fetchFn = createMockFetch(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? "GET";

			if (url.endsWith("/login") && method === "POST") {
				return new Response("", {
					status: 302,
					headers: {
						"Set-Cookie": "JSESSIONID=test; Path=/; HttpOnly",
					},
				});
			}

			if (url.endsWith("/") && method === "GET") {
				return new Response(
					'<input name="javax.faces.ViewState" value="view-root"><input name="form:idInit" value="root-id">',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "GET") {
				return new Response(
					"<a onclick=\"PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'planning-menu'})\"><span class=\"ui-menuitem-icon ui-icon fa fa-calendar-alt\"></span><span class=\"ui-menuitem-text\">Mon Planning</span></a>",
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "POST") {
				return new Response("sidebar-ok", { status: 200 });
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "GET") {
				return new Response(
					'<input name="javax.faces.ViewState" value="view-planning"><script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning"});</script>',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "POST") {
				capturedPlanningRequests.push(new URLSearchParams(init?.body?.toString() ?? ""));
				return new Response(
					'[{"id":"event-inside","title":"Inside","start":"2025-01-01T10:15:00.000Z","end":"2025-01-01T10:45:00.000Z","allDay":false,"editable":false,"className":"Cours"}]',
					{ status: 200 },
				);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		});

		const session = createSession(
			{
				timeRangeApproximation: {
					planning: {
						unit: "hour",
					},
				},
			},
			{ fetchFn },
		);

		await expect(session.getPlanning(requestedWindow)).resolves.toEqual([
			{
				id: "event-inside",
				title: "Inside",
				start: new Date("2025-01-01T10:15:00.000Z"),
				end: new Date("2025-01-01T10:45:00.000Z"),
				allDay: false,
				editable: false,
				type: "Cours",
			},
		]);

		expect(capturedPlanningRequests).toHaveLength(1);

		const planningRequest = capturedPlanningRequests[0];
		if (!planningRequest) {
			throw new Error("Expected one captured planning request");
		}

		expect(planningRequest.get("form:planning_start")).toBe(
			String(new Date("2025-01-01T10:00:00.000Z").getTime()),
		);
		expect(planningRequest.get("form:planning_end")).toBe(
			String(new Date("2025-01-01T11:00:00.000Z").getTime()),
		);
		expect(planningRequest.get("form:date_input")).toBe("01/01/2025");
		expect(planningRequest.get("form:week")).toBe("01-2025");
	});

	test("AurionSession reuses resolved navigation nodes between uncached planning requests", async () => {
		const counts = {
			root: 0,
			mainMenuGet: 0,
			mainMenuPost: 0,
			planningGet: 0,
			planningPost: 0,
		};
		const fetchFn = createMockFetch(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? "GET";

			if (url.endsWith("/login") && method === "POST") {
				return new Response("", {
					status: 302,
					headers: {
						"Set-Cookie": "JSESSIONID=test; Path=/; HttpOnly",
					},
				});
			}

			if (url.endsWith("/") && method === "GET") {
				counts.root += 1;
				return new Response(
					'<input name="javax.faces.ViewState" value="view-root"><input name="form:idInit" value="root-id">',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "GET") {
				counts.mainMenuGet += 1;
				return new Response(
					"<a onclick=\"PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'planning-menu'})\"><span class=\"ui-menuitem-icon ui-icon fa fa-calendar-alt\"></span><span class=\"ui-menuitem-text\">Mon Planning</span></a>",
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "POST") {
				counts.mainMenuPost += 1;
				return new Response("sidebar-ok", { status: 200 });
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "GET") {
				counts.planningGet += 1;
				return new Response(
					'<input name="javax.faces.ViewState" value="view-planning"><script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning"});</script>',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "POST") {
				counts.planningPost += 1;
				return new Response(
					'[{"id":"event-inside","title":"Inside","start":"2025-01-01T10:45:00.000Z","end":"2025-01-01T11:00:00.000Z","allDay":false,"editable":false,"className":"Cours"}]',
					{ status: 200 },
				);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		});

		const session = createSession(false, { fetchFn });

		await expect(
			session.getPlanning({
				start: new Date("2025-01-01T10:00:00.000Z"),
				end: new Date("2025-01-01T11:00:00.000Z"),
			}),
		).resolves.toHaveLength(1);
		await expect(
			session.getPlanning({
				start: new Date("2025-01-01T10:30:00.000Z"),
				end: new Date("2025-01-01T11:30:00.000Z"),
			}),
		).resolves.toHaveLength(1);

		expect(counts).toEqual({
			root: 1,
			mainMenuGet: 1,
			mainMenuPost: 1,
			planningGet: 1,
			planningPost: 2,
		});
	});

	test("AurionSession invalidates stale navigation nodes and rebuilds descendants once", async () => {
		const counts = {
			root: 0,
			mainMenuGet: 0,
			mainMenuPost: 0,
			planningGet: 0,
			planningPost: 0,
		};
		const fetchFn = createMockFetch(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? "GET";

			if (url.endsWith("/login") && method === "POST") {
				return new Response("", {
					status: 302,
					headers: {
						"Set-Cookie": "JSESSIONID=test; Path=/; HttpOnly",
					},
				});
			}

			if (url.endsWith("/") && method === "GET") {
				counts.root += 1;
				return new Response(
					`<input name="javax.faces.ViewState" value="view-root-${counts.root}"><input name="form:idInit" value="root-id-${counts.root}">`,
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "GET") {
				counts.mainMenuGet += 1;
				return new Response(
					"<a onclick=\"PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'planning-menu'})\"><span class=\"ui-menuitem-icon ui-icon fa fa-calendar-alt\"></span><span class=\"ui-menuitem-text\">Mon Planning</span></a>",
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "POST") {
				counts.mainMenuPost += 1;
				return new Response("sidebar-ok", { status: 200 });
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "GET") {
				counts.planningGet += 1;
				return new Response(
					`<input name="javax.faces.ViewState" value="view-planning-${counts.planningGet}"><script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning"});</script>`,
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "POST") {
				counts.planningPost += 1;

				if (counts.planningPost === 2) {
					return new Response("stale view state", { status: 500 });
				}

				const postData = new URLSearchParams(init?.body?.toString() ?? "");
				const startTimestamp = Number(postData.get("form:planning_start"));
				const eventStart = new Date(startTimestamp + 15 * 60 * 1000);
				const eventEnd = new Date(startTimestamp + 30 * 60 * 1000);

				return new Response(
					`[{"id":"event-${counts.planningPost}","title":"Inside","start":"${eventStart.toISOString()}","end":"${eventEnd.toISOString()}","allDay":false,"editable":false,"className":"Cours"}]`,
					{ status: 200 },
				);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		});

		const session = createSession(false, { fetchFn });

		await expect(
			session.getPlanning({
				start: new Date("2025-01-01T10:00:00.000Z"),
				end: new Date("2025-01-01T11:00:00.000Z"),
			}),
		).resolves.toHaveLength(1);
		await expect(
			session.getPlanning({
				start: new Date("2025-01-01T12:00:00.000Z"),
				end: new Date("2025-01-01T13:00:00.000Z"),
			}),
		).resolves.toHaveLength(1);

		expect(counts).toEqual({
			root: 2,
			mainMenuGet: 2,
			mainMenuPost: 2,
			planningGet: 2,
			planningPost: 3,
		});
	});

	test("AurionSession keeps navigation nodes isolated between sessions sharing a cache store", async () => {
		const cacheStore = new InMemoryAurionCache();
		const countsBySession = new Map<string, PlanningNavigationCounts>();
		const fetchFn = createMockFetch(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? "GET";
			const sessionId = url.includes("session-b.test") ? "session-b" : "session-a";
			const counts = getPlanningCounts(countsBySession, sessionId);

			if (url.endsWith("/login") && method === "POST") {
				return new Response("", {
					status: 302,
					headers: {
						"Set-Cookie": `${sessionId}=test; Path=/; HttpOnly`,
					},
				});
			}

			if (url.endsWith("/") && method === "GET") {
				counts.root += 1;
				return new Response(
					`<input name="javax.faces.ViewState" value="view-root-${sessionId}"><input name="form:idInit" value="root-id-${sessionId}">`,
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "GET") {
				counts.mainMenuGet += 1;
				return new Response(
					"<a onclick=\"PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'planning-menu'})\"><span class=\"ui-menuitem-icon ui-icon fa fa-calendar-alt\"></span><span class=\"ui-menuitem-text\">Mon Planning</span></a>",
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "POST") {
				counts.mainMenuPost += 1;
				return new Response("sidebar-ok", { status: 200 });
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "GET") {
				counts.planningGet += 1;
				return new Response(
					`<input name="javax.faces.ViewState" value="view-planning-${sessionId}"><script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning"});</script>`,
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "POST") {
				counts.planningPost += 1;
				const postData = new URLSearchParams(init?.body?.toString() ?? "");
				const startTimestamp = Number(postData.get("form:planning_start"));
				const eventStart = new Date(startTimestamp + 15 * 60 * 1000);
				const eventEnd = new Date(startTimestamp + 30 * 60 * 1000);

				return new Response(
					`[{"id":"event-${sessionId}-${counts.planningPost}","title":"Inside","start":"${eventStart.toISOString()}","end":"${eventEnd.toISOString()}","allDay":false,"editable":false,"className":"Cours"}]`,
					{ status: 200 },
				);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		});

		const firstSession = createSession(cacheStore, {
			baseUrl: "https://session-a.test",
			fetchFn,
		});
		const secondSession = createSession(cacheStore, {
			baseUrl: "https://session-b.test",
			fetchFn,
		});
		const planningWindow = {
			start: new Date("2025-01-01T10:00:00.000Z"),
			end: new Date("2025-01-01T11:00:00.000Z"),
		};

		await expect(firstSession.getPlanning(planningWindow)).resolves.toHaveLength(1);
		await expect(secondSession.getPlanning(planningWindow)).resolves.toHaveLength(1);
		await expect(firstSession.getPlanning({
			start: new Date("2025-01-01T12:00:00.000Z"),
			end: new Date("2025-01-01T13:00:00.000Z"),
		})).resolves.toHaveLength(1);

		expect(countsBySession.get("session-a")).toEqual({
			root: 1,
			mainMenuGet: 1,
			mainMenuPost: 1,
			planningGet: 1,
			planningPost: 2,
		});
		expect(countsBySession.get("session-b")).toEqual({
			root: 1,
			mainMenuGet: 1,
			mainMenuPost: 1,
			planningGet: 1,
			planningPost: 1,
		});
	});

	test("AurionSession reuses form-capable root for sibling branches without reusing page-specific nodes", async () => {
		const counts = {
			root: 0,
			planningMainMenuGet: 0,
			planningMainMenuPost: 0,
			planningGet: 0,
			planningPost: 0,
			absencesMainMenuPost: 0,
			absencesGet: 0,
			absencesPost: 0,
		};
		const fetchFn = createMockFetch(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const method = init?.method ?? "GET";

			if (url.endsWith("/login") && method === "POST") {
				return new Response("", {
					status: 302,
					headers: {
						"Set-Cookie": "JSESSIONID=test; Path=/; HttpOnly",
					},
				});
			}

			if (url.endsWith("/") && method === "GET") {
				counts.root += 1;
				return new Response(
					'>chargerSousMenu = function(){PrimeFaces.ab({s:"form:j_idt1",f:"form"});}<input name="javax.faces.ViewState" value="view-root"><input name="form:idInit" value="root-id">',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "GET") {
				counts.planningMainMenuGet += 1;
				return new Response(
					"<a onclick=\"PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'planning-menu'})\"><span class=\"ui-menuitem-icon ui-icon fa fa-calendar-alt\"></span><span class=\"ui-menuitem-text\">Mon Planning</span></a>",
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MainMenuPage.xhtml") && method === "POST") {
				const body = init?.body?.toString() ?? "";
				if (body.includes("webscolaapp.Sidebar.ID_SUBMENU")) {
					counts.absencesMainMenuPost += 1;
					return new Response("<update>form:sidebar_menuid:'absences-menu' Mes absences</span></update>", {
						status: 200,
					});
				}

				counts.planningMainMenuPost += 1;
				return new Response("sidebar-ok", { status: 200 });
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "GET") {
				counts.planningGet += 1;
				return new Response(
					'<input name="javax.faces.ViewState" value="view-planning"><script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning"});</script>',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/Planning.xhtml") && method === "POST") {
				counts.planningPost += 1;
				return new Response(
					'[{"id":"event-inside","title":"Inside","start":"2025-01-01T10:15:00.000Z","end":"2025-01-01T10:45:00.000Z","allDay":false,"editable":false,"className":"Cours"}]',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MesAbsences.xhtml") && method === "GET") {
				counts.absencesGet += 1;
				return new Response(
					'<input name="javax.faces.ViewState" value="view-absences"><input name="form:idInit" value="absences-id">',
					{ status: 200 },
				);
			}

			if (url.endsWith("/faces/MesAbsences.xhtml") && method === "POST") {
				counts.absencesPost += 1;
				return new Response('<tbody class="ui-datatable-data"></tbody>', { status: 200 });
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		});

		const session = createSession(false, { fetchFn });

		await expect(session.getAbsences()).resolves.toEqual([]);
		await expect(
			session.getPlanning({
				start: new Date("2025-01-01T10:00:00.000Z"),
				end: new Date("2025-01-01T11:00:00.000Z"),
			}),
		).resolves.toHaveLength(1);

			expect(counts).toEqual({
			root: 1,
			planningMainMenuGet: 1,
			planningMainMenuPost: 2,
			planningGet: 1,
			planningPost: 1,
			absencesMainMenuPost: 1,
			absencesGet: 1,
			absencesPost: 1,
		});
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
				throw new Error(
					"network should be attempted because the baseUrl-specific cache key differs",
				);
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

		const session = createSession(
			{
				store: cacheStore,
				sessionMaxAgeMs: 1,
			},
			{
				fetchFn: createMockFetch(async () => {
					throw new Error("expired session cache should fall through to the network");
				}),
			},
		);

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
