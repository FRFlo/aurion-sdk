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

/** Options nécessaires à la construction du transport HTTP Aurion. */
interface AurionTransportOptions {
	/** Identifiant envoyé au formulaire d'authentification Aurion. */
	username: string;
	/** Secret transmis uniquement lors de l'authentification distante. */
	password: string;
	/** URL de base de l'instance Aurion ciblée. */
	baseUrl: string;
	/** Store partagé par les caches de session et de transport, ou `null` pour les désactiver. */
	cacheStore: AurionCacheStore | null;
	/** Durée maximale de conservation des réponses HTTP en millisecondes. */
	cacheMaxAgeMs?: number;
	/** Délai maximal d'une requête réseau en millisecondes. */
	requestTimeoutMs?: number;
	/** Fonction Fetch personnalisée, principalement utile aux environnements et tests. */
	fetchFn?: typeof fetch;
}

/** Options d'une requête HTTP exécutée par le transport. */
interface TransportRequestOptions {
	/** Chemin relatif ou URL absolue de la requête. */
	path: string;
	/** Méthode HTTP ; GET est utilisé par défaut. */
	method?: HttpMethod;
	/** Corps sérialisé de la requête, si nécessaire. */
	body?: URLSearchParams | string;
	/** En-têtes supplémentaires à envoyer. */
	headers?: HeadersInit;
	/** Indique si les redirections doivent être suivies manuellement. */
	followRedirects?: boolean;
	/** Autorise la lecture ou l'écriture du cache de transport. */
	cache?: boolean;
	/** Annule uniquement cette requête HTTP. */
	signal?: AbortSignal;
	/** Marque la reprise unique après expiration de session. */
	_authRetryAttempted?: boolean;
}

/** Résultat interne d'un Fetch avec suivi manuel des redirections. */
interface RedirectedFetchResult {
	/** Réponse Fetch finale après suivi éventuel des redirections. */
	response: Response;
	/** Statut de la toute première réponse de la chaîne. */
	initialStatus: number;
	/** URL finale atteinte après les redirections. */
	finalUrl: URL;
}

/** Réponse HTTP normalisée renvoyée aux composants internes du SDK. */
export interface AurionTransportResponse {
	/** Statut HTTP final. */
	status: number;
	/** Statut HTTP initial, avant toute redirection. */
	initialStatus: number;
	/** URL finale de la réponse. */
	url: string;
	/** Corps de réponse lu en texte. */
	body: string;
	/** En-têtes de la réponse finale. */
	headers: Headers;
	/** Vaut `true` lorsque la réponse provient du cache de transport. */
	fromCache: boolean;
}

const DEFAULT_HEADERS: HeadersInit = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const LOGIN_PATH = "/login";
const MAX_REDIRECTS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Attend une promesse ou rejette dès que le signal facultatif est annulé.
 * @param promise Opération partagée à attendre sans l'annuler elle-même.
 * @param signal Signal propre à l'appelant qui peut interrompre son attente.
 * @returns La valeur de l'opération si elle se termine avant l'annulation.
 * @throws La raison d'annulation du signal, ou l'erreur de la promesse.
 */
function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

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
	private readonly requestTimeoutMs: number;
	private readonly username: string;
	readonly #password: string;
	private loginPromise: Promise<void> | null = null;
	private authenticated = false;
	private sessionGeneration = 0;

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
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
			throw new RangeError("requestTimeoutMs must be a finite, positive number.");
		}
		this.username = options.username;
		this.#password = options.password;
	}

	/**
	 * Authentifie la session et garantit une initialisation unique en parallèle.
	 *
	 * @param signal Signal qui permet à cet appelant d'arrêter son attente.
	 * @returns Une promesse résolue lorsque la session distante est prête.
	 * @throws {AurionError} Si l'authentification ou l'initialisation réseau échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé ; la connexion partagée continue.
	 */
	async login(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
		}
		if (this.authenticated) {
			return;
		}

		if (!this.loginPromise) {
			const loginPromise = this.loginInternal();
			this.loginPromise = loginPromise;
			void loginPromise.then(
				() => {
					this.authenticated = true;
					this.sessionGeneration += 1;
					this.loginPromise = null;
				},
				() => {
					this.loginPromise = null;
				},
			);
		}

		const loginPromise = this.loginPromise;
		if (loginPromise) {
			await waitForAbort(loginPromise, signal);
		}
	}

	/**
	 * Exécute une requête Aurion et normalise la réponse retournée.
	 *
	 * @param options Paramètres HTTP de la requête à exécuter.
	 * @returns La réponse HTTP normalisée, éventuellement issue du cache.
	 * @throws {AurionError} Si le transport rencontre une erreur réseau ou de redirection.
	 * @throws {AbortError} Si le signal de la requête est annulé.
	 */
	async request(options: TransportRequestOptions): Promise<AurionTransportResponse> {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
		}
		const requestSessionGeneration = this.sessionGeneration;
		const method = (options.method ?? "GET").toUpperCase() as HttpMethod;
		const url = this.resolveUrl(options.path);
		const requestBody = stringifyBody(options.body);
		const followRedirects = options.followRedirects ?? true;
		const headers = new Headers(DEFAULT_HEADERS);
		if (options.headers) {
			applyHeaders(headers, options.headers);
		}

		if (method === "POST" && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/x-www-form-urlencoded");
		}

		const customHeaders = new Headers(options.headers);
		const headerVariant = Array.from(customHeaders.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => `${name}:${value}`)
			.join("&");
		const cacheVariant = `${followRedirects ? "follow" : "manual"}:${headerVariant}`;
		const shouldUseCache =
			(options.cache ?? true) &&
			this.cacheStore !== null &&
			(method === "GET" || method === "POST");
		const cacheKey = shouldUseCache
			? createAurionCacheKey(
					`transport:${this.username}`,
					method,
					url.toString(),
					requestBody,
					cacheVariant,
				)
			: null;

		if (cacheKey && this.cacheStore) {
			const cached = await this.cacheStore.get(cacheKey);
			if (options.signal?.aborted) {
				throw options.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
			}
			if (isAurionTransportCacheEntry(cached)) {
				if (
					isAurionCacheEntryExpired(cached, this.cacheMaxAgeMs) ||
					!isSuccessfulStatus(cached.status) ||
					isLoginPageUrl(cached.url)
				) {
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
			} else if (cached !== undefined) {
				await this.cacheStore.delete(cacheKey);
			}
		}

		const timeoutController = new AbortController();
		const timeoutId = setTimeout(
			() => timeoutController.abort(new DOMException("Aurion request timed out.", "TimeoutError")),
			this.requestTimeoutMs,
		);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutController.signal])
			: timeoutController.signal;

		try {
			const { response, initialStatus, finalUrl } = await waitForAbort(
				this.fetchWithManualRedirects(
					url,
					{ method, headers, body: requestBody },
					followRedirects,
					signal,
				),
				signal,
			);
			const body = await waitForAbort(response.text(), signal);

			if (
				!options._authRetryAttempted &&
				url.pathname.toLowerCase() !== LOGIN_PATH &&
				isLoginPageUrl(finalUrl.toString())
			) {
				if (this.authenticated && this.sessionGeneration === requestSessionGeneration) {
					this.authenticated = false;
					this.loginPromise = null;
					this.cookieJar.clear();
					this.sessionGeneration += 1;
				}
				await this.login(options.signal);
				return await this.request({ ...options, _authRetryAttempted: true });
			}

			const transportResponse: AurionTransportResponse = {
				status: response.status,
				initialStatus,
				url: finalUrl.toString(),
				body,
				headers: response.headers,
				fromCache: false,
			};

			if (
				cacheKey &&
				isSuccessfulStatus(transportResponse.status) &&
				!isLoginPageUrl(transportResponse.url)
			) {
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
		} catch (error: unknown) {
			if (options.signal?.aborted) throw options.signal.reason ?? error;
			if (timeoutController.signal.aborted) {
				throw createAurionError(
					"AURION_TRANSPORT_ERROR",
					`La requête Aurion a dépassé le délai maximal de ${this.requestTimeoutMs} ms.`,
					{ timeoutMs: this.requestTimeoutMs, cause: error },
				);
			}
			if (isAurionError(error)) throw error;
			throw createAurionError(
				"AURION_TRANSPORT_ERROR",
				"La réponse réseau Aurion est illisible.",
				error,
			);
		} finally {
			clearTimeout(timeoutId);
		}
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
			password: this.#password,
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
				url: loginResponse.url,
				expected: 302,
			});
		}

		if (!this.cookieJar.hasCookies()) {
			throw createAurionError(
				"AURION_AUTHENTICATION_ERROR",
				"Authentification Aurion invalide: aucun cookie de session reçu.",
				{
					status: loginResponse.initialStatus,
					url: loginResponse.url,
					expected: "session cookie",
				},
			);
		}
	}

	/**
	 * Suit explicitement les redirections pour maîtriser cookies et méthode HTTP.
	 *
	 * @param initialUrl URL de départ de la requête.
	 * @param requestInit Méthode, en-têtes et corps à utiliser pour la requête initiale.
	 * @param followRedirects Indique si les redirections HTTP doivent être suivies manuellement.
	 * @param signal Signal facultatif transmis à chaque requête de la chaîne.
	 * @returns La réponse finale accompagnée du premier statut et de l'URL atteinte.
	 * @throws {AurionError} Si une erreur réseau survient ou si le nombre maximal de redirections est dépassé.
	 * @throws {AbortError} Si le signal interrompt une requête de la chaîne.
	 */
	private async fetchWithManualRedirects(
		initialUrl: URL,
		requestInit: {
			method: HttpMethod;
			headers: Headers;
			body: string | undefined;
		},
		followRedirects: boolean,
		signal?: AbortSignal,
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
					signal,
				});
			} catch (error: unknown) {
				if (signal?.aborted) {
					throw signal.reason ?? error;
				}
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
					{
						url: currentUrl.toString(),
						status: response.status,
						redirectCount: redirectCount + 1,
						maxRedirects: MAX_REDIRECTS,
					},
				);
			}

			const nextUrl = new URL(location, currentUrl);
			if (nextUrl.origin !== currentUrl.origin) {
				currentHeaders.delete("authorization");
				currentHeaders.delete("proxy-authorization");
				currentHeaders.delete("cookie");
			}
			currentUrl = nextUrl;
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
			{
				url: currentUrl.toString(),
				method: currentMethod,
				maxRedirects: MAX_REDIRECTS,
			},
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
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSuccessfulStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

function isLoginPageUrl(url: string): boolean {
	try {
		return /(?:^|\/)login(?:\.xhtml)?\/?$/i.test(new URL(url).pathname);
	} catch {
		return false;
	}
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
