import type { HeadersInit } from "bun";
import { InMemoryCookieJar } from "./cookie-jar";
import { createAurionError, isAurionError } from "./errors";

type HttpMethod = "GET" | "POST";

/** Paramètres de construction du transport HTTP Aurion. */
interface AurionTransportOptions {
	username: string;
	password: string;
	baseUrl: string;
	cache: boolean;
	fetchFn?: typeof fetch;
}

/** Options d'une requête HTTP exécutée par le transport. */
interface TransportRequestOptions {
	path: string;
	method?: HttpMethod;
	body?: URLSearchParams | string;
	headers?: HeadersInit;
	followRedirects?: boolean;
	cache?: boolean;
}

/** Résultat interne d'un fetch avec suivi manuel des redirections. */
interface RedirectedFetchResult {
	response: Response;
	initialStatus: number;
	finalUrl: URL;
}

/** Représentation sérialisable d'une réponse mise en cache. */
interface CachedTransportResponse {
	status: number;
	initialStatus: number;
	url: string;
	body: string;
	headers: [string, string][];
}

/** Réponse HTTP normalisée renvoyée au reste du SDK. */
export interface AurionTransportResponse {
	status: number;
	initialStatus: number;
	url: string;
	body: string;
	headers: Headers;
	fromCache: boolean;
}

const DEFAULT_HEADERS: HeadersInit = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const LOGIN_PATH = "/login";
const MAX_REDIRECTS = 10;

/**
 * Couche HTTP Aurion avec gestion des cookies, cache optionnel
 * et redirections manuelles.
 */
export class AurionTransport {
	private readonly fetchFn: typeof fetch;
	private readonly baseUrl: URL;
	private readonly cookieJar = new InMemoryCookieJar();
	private readonly responseCache = new Map<string, CachedTransportResponse>();
	private readonly cacheEnabled: boolean;
	private readonly username: string;
	private readonly password: string;
	private loginPromise: Promise<void> | null = null;
	private authenticated = false;

	constructor(options: AurionTransportOptions) {
		this.fetchFn = options.fetchFn ?? fetch;
		this.baseUrl = new URL(options.baseUrl);
		this.cacheEnabled = options.cache;
		this.username = options.username;
		this.password = options.password;
	}

	/** Authentifie la session et garantit une initialisation unique en parallèle. */
	async login(): Promise<void> {
		if (this.authenticated) {
			return;
		}

		if (!this.loginPromise) {
			this.loginPromise = this.loginInternal();
		}

		try {
			await this.loginPromise;
			this.authenticated = true;
		} finally {
			this.loginPromise = null;
		}
	}

	/** Exécute une requête Aurion et normalise la réponse retournée. */
	async request(options: TransportRequestOptions): Promise<AurionTransportResponse> {
		const method = (options.method ?? "GET").toUpperCase() as HttpMethod;
		const url = this.resolveUrl(options.path);
		const requestBody = stringifyBody(options.body);
		const followRedirects = options.followRedirects ?? true;
		const shouldUseCache =
			(options.cache ?? true) && this.cacheEnabled && (method === "GET" || method === "POST");
		const cacheKey = shouldUseCache ? `${method}:${url.toString()}:${requestBody ?? ""}` : null;

		if (cacheKey && this.responseCache.has(cacheKey)) {
			const cached = this.responseCache.get(cacheKey);
			if (cached) {
				return {
					status: cached.status,
					initialStatus: cached.initialStatus,
					url: cached.url,
					body: cached.body,
					headers: new Headers(cached.headers),
					fromCache: true,
				};
			}
		}

		const headers = new Headers(DEFAULT_HEADERS);
		if (options.headers) {
			applyHeaders(headers, options.headers);
		}

		if (method === "POST" && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/x-www-form-urlencoded");
		}

		const { response, initialStatus, finalUrl } = await this.fetchWithManualRedirects(
			url,
			{
				method,
				headers,
				body: requestBody,
			},
			followRedirects,
		);

		const body = await response.text();
		const transportResponse: AurionTransportResponse = {
			status: response.status,
			initialStatus,
			url: finalUrl.toString(),
			body,
			headers: response.headers,
			fromCache: false,
		};

		if (cacheKey) {
			this.responseCache.set(cacheKey, {
				status: transportResponse.status,
				initialStatus: transportResponse.initialStatus,
				url: transportResponse.url,
				body: transportResponse.body,
				headers: Array.from(transportResponse.headers.entries()),
			});
		}

		return transportResponse;
	}

	/** Soumet le formulaire de connexion puis valide la création de session. */
	private async loginInternal(): Promise<void> {
		const payload = new URLSearchParams({
			username: this.username,
			password: this.password,
			j_idt28: "",
		});

		let loginResponse: AurionTransportResponse;

		try {
			loginResponse = await this.request({
				path: LOGIN_PATH,
				method: "POST",
				body: payload,
				cache: false,
				followRedirects: false,
			});
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_TRANSPORT_ERROR",
				"Impossible de contacter Aurion pour l'authentification.",
				error,
			);
		}

		if (loginResponse.initialStatus !== 302) {
			throw createAurionError("AURION_AUTHENTICATION_ERROR", "Authentification Aurion invalide.", {
				status: loginResponse.initialStatus,
			});
		}

		if (!this.cookieJar.hasCookies()) {
			throw createAurionError(
				"AURION_AUTHENTICATION_ERROR",
				"Authentification Aurion invalide: aucun cookie de session reçu.",
			);
		}
	}

	/** Suit explicitement les redirections pour maîtriser cookies et méthode HTTP. */
	private async fetchWithManualRedirects(
		initialUrl: URL,
		requestInit: {
			method: HttpMethod;
			headers: Headers;
			body: string | undefined;
		},
		followRedirects: boolean,
	): Promise<RedirectedFetchResult> {
		let currentUrl = initialUrl;
		let currentMethod = requestInit.method;
		let currentHeaders = new Headers(requestInit.headers);
		let currentBody = requestInit.body;
		let initialStatus = -1;

		for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
			const requestHeaders = new Headers(currentHeaders);
			const cookieHeader = this.cookieJar.toRequestCookieHeader(currentUrl);
			if (cookieHeader) {
				requestHeaders.set("Cookie", cookieHeader);
			}

			let response: Response;

			try {
				response = await this.fetchFn(currentUrl, {
					method: currentMethod,
					headers: requestHeaders,
					body: currentBody,
					redirect: "manual",
				});
			} catch (error: unknown) {
				throw createAurionError(
					"AURION_TRANSPORT_ERROR",
					"La requête réseau Aurion a échoué.",
					error,
				);
			}

			if (initialStatus === -1) {
				initialStatus = response.status;
			}

			this.cookieJar.ingestResponseCookies(response.headers, currentUrl);

			const shouldFollowRedirect = followRedirects && isRedirectStatus(response.status);
			if (!shouldFollowRedirect) {
				return {
					response,
					initialStatus,
					finalUrl: currentUrl,
				};
			}

			const location = response.headers.get("location");
			if (!location) {
				return {
					response,
					initialStatus,
					finalUrl: currentUrl,
				};
			}

			if (redirectCount === MAX_REDIRECTS) {
				throw createAurionError(
					"AURION_TRANSPORT_ERROR",
					"Trop de redirections durant la session Aurion.",
					{ url: currentUrl.toString() },
				);
			}

			currentUrl = new URL(location, currentUrl);
			const rewritten = rewriteRedirectRequest(
				currentMethod,
				currentHeaders,
				currentBody,
				response.status,
			);

			currentMethod = rewritten.method;
			currentHeaders = rewritten.headers;
			currentBody = rewritten.body;
		}

		throw createAurionError(
			"AURION_TRANSPORT_ERROR",
			"Échec inattendu lors de la gestion des redirections Aurion.",
		);
	}

	/** Résout un chemin relatif Aurion sur l'URL de base configurée. */
	private resolveUrl(path: string): URL {
		return new URL(path, this.baseUrl);
	}
}

/** Copie différentes formes de headers vers un objet Headers mutable. */
function applyHeaders(target: Headers, source: HeadersInit): void {
	if (source instanceof Headers) {
		for (const [key, value] of source.entries()) {
			target.set(key, value);
		}
		return;
	}

	if (Array.isArray(source)) {
		for (const [key, value] of source) {
			if (key !== undefined && value !== undefined) {
				target.set(key, value);
			}
		}
		return;
	}

	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) {
			if (typeof value === "string") {
				target.set(key, value);
				continue;
			}

			if (Array.isArray(value)) {
				target.set(key, value.join(", "));
				continue;
			}
		}
	}
}

/** Convertit un body optionnel en chaîne prête pour fetch. */
function stringifyBody(body: URLSearchParams | string | undefined): string | undefined {
	if (body === undefined) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	return body.toString();
}

/** Indique si un code HTTP correspond à une redirection. */
function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

/** Réécrit la requête suivante selon les règles HTTP de redirection. */
function rewriteRedirectRequest(
	method: HttpMethod,
	headers: Headers,
	body: string | undefined,
	status: number,
): {
	method: HttpMethod;
	headers: Headers;
	body: string | undefined;
} {
	const rewrittenHeaders = new Headers(headers);

	const shouldSwitchToGet =
		status === 303 || ((status === 301 || status === 302) && method === "POST");

	if (!shouldSwitchToGet) {
		return {
			method,
			headers: rewrittenHeaders,
			body,
		};
	}

	rewrittenHeaders.delete("Content-Type");
	rewrittenHeaders.delete("Content-Length");

	return {
		method: "GET",
		headers: rewrittenHeaders,
		body: undefined,
	};
}
