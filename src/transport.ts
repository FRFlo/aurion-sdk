import type { HeadersInit } from "bun";
import {
	createAurionCacheKey,
	isAurionCacheEntryExpired,
	isAurionTransportCacheEntry,
} from "./cache";
import { InMemoryCookieJar } from "./cookie-jar";
import { createAurionError, isAurionError } from "./errors";
import type { AurionCacheStore, AurionTransportCacheEntry } from "./cache";

type HttpMethod = "GET" | "POST";

/** Paramètres de construction du transport HTTP Aurion. */
interface AurionTransportOptions {
	username: string;
	password: string;
	baseUrl: string;
	cacheStore: AurionCacheStore | null;
	cacheMaxAgeMs?: number;
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
	private readonly cacheStore: AurionCacheStore | null;
	private readonly cacheMaxAgeMs?: number;
	private readonly username: string;
	private readonly password: string;
	private loginPromise: Promise<void> | null = null;
	private authenticated = false;

	/**
	 * Initialise le transport HTTP Aurion et ses dépendances réseau.
	 *
	 * @param options Paramètres de base du transport, dont les identifiants et l'URL cible.
	 */
	constructor(options: AurionTransportOptions) {
		this.fetchFn = options.fetchFn ?? fetch;
		this.baseUrl = new URL(options.baseUrl);
		this.cacheStore = options.cacheStore;
		this.cacheMaxAgeMs = options.cacheMaxAgeMs;
		this.username = options.username;
		this.password = options.password;
	}

	/**
	 * Authentifie la session et garantit une initialisation unique en parallèle.
	 *
	 * @returns Une promesse résolue lorsque la session distante est prête.
	 * @throws {AurionError} Si l'authentification ou l'initialisation réseau échoue.
	 */
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

	/**
	 * Exécute une requête Aurion et normalise la réponse retournée.
	 *
	 * @param options Paramètres HTTP de la requête à exécuter.
	 * @returns La réponse HTTP normalisée, éventuellement issue du cache.
	 * @throws {AurionError} Si le transport rencontre une erreur réseau ou de redirection.
	 */
	async request(options: TransportRequestOptions): Promise<AurionTransportResponse> {
		const method = (options.method ?? "GET").toUpperCase() as HttpMethod;
		const url = this.resolveUrl(options.path);
		const requestBody = stringifyBody(options.body);
		const followRedirects = options.followRedirects ?? true;
		const shouldUseCache =
			(options.cache ?? true) &&
			this.cacheStore !== null &&
			(method === "GET" || method === "POST");
		const cacheKey = shouldUseCache
			? createAurionCacheKey("transport", method, url.toString(), requestBody)
			: null;

		if (cacheKey && this.cacheStore) {
			const cached = await this.cacheStore.get(cacheKey);
			if (isAurionTransportCacheEntry(cached)) {
				if (isAurionCacheEntryExpired(cached, this.cacheMaxAgeMs)) {
					await this.cacheStore.delete(cacheKey);
				} else {
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
			const cacheEntry: AurionTransportCacheEntry = {
				kind: "transport",
				createdAt: Date.now(),
				status: transportResponse.status,
				initialStatus: transportResponse.initialStatus,
				url: transportResponse.url,
				body: transportResponse.body,
				headers: Array.from(transportResponse.headers.entries()),
			};

			await this.cacheStore?.set(cacheKey, cacheEntry);
		}

		return transportResponse;
	}

	/**
	 * Soumet le formulaire de connexion puis valide la création de session.
	 *
	 * @returns Une promesse résolue lorsque les cookies de session sont établis.
	 * @throws {AurionError} Si l'authentification échoue ou si aucun cookie de session n'est reçu.
	 */
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

	/**
	 * Suit explicitement les redirections pour maîtriser cookies et méthode HTTP.
	 *
	 * @param initialUrl URL de départ de la requête.
	 * @param requestInit Méthode, en-têtes et corps à utiliser pour la requête initiale.
	 * @param followRedirects Indique si les redirections HTTP doivent être suivies manuellement.
	 * @returns La réponse finale accompagnée du premier statut et de l'URL atteinte.
	 * @throws {AurionError} Si une erreur réseau survient ou si le nombre maximal de redirections est dépassé.
	 */
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

	/**
	 * Résout un chemin relatif Aurion sur l'URL de base configurée.
	 *
	 * @param path Chemin relatif ou absolu Aurion à résoudre.
	 * @returns L'URL absolue correspondante.
	 */
	private resolveUrl(path: string): URL {
		return new URL(path, this.baseUrl);
	}
}

/**
 * Copie différentes formes de headers vers un objet Headers mutable.
 *
 * @param target Objet `Headers` mutable à enrichir.
 * @param source Valeur source au format `HeadersInit`.
 * @returns Rien ; la mutation est appliquée sur `target`.
 */
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

/**
 * Convertit un body optionnel en chaîne prête pour fetch.
 *
 * @param body Corps brut éventuel de la requête.
 * @returns Le corps sérialisé en chaîne, ou `undefined` s'il est absent.
 */
function stringifyBody(body: URLSearchParams | string | undefined): string | undefined {
	if (body === undefined) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	return body.toString();
}

/**
 * Indique si un code HTTP correspond à une redirection.
 *
 * @param status Code HTTP à évaluer.
 * @returns `true` si le statut correspond à une redirection HTTP.
 */
function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

/**
 * Réécrit la requête suivante selon les règles HTTP de redirection.
 *
 * @param method Méthode HTTP de la requête précédente.
 * @param headers En-têtes de la requête précédente.
 * @param body Corps sérialisé de la requête précédente.
 * @param status Code HTTP de redirection reçu.
 * @returns La méthode, les en-têtes et le corps à réutiliser pour la requête suivante.
 */
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
