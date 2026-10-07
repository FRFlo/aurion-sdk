/** Valeur renvoyée directement ou via une promesse par une opération de store. */
type Awaitable<T> = T | Promise<T>;

/**
 * Entrée de cache représentant une réponse HTTP sérialisée par le transport.
 */
export interface AurionTransportCacheEntry {
	/** Discriminant utilisé pour identifier une entrée de transport. */
	kind: "transport";
	/** Horodatage Unix en millisecondes de création de l'entrée, utilisé pour le TTL. */
	createdAt?: number;
	/** Code HTTP final renvoyé par Aurion pour cette réponse. */
	status: number;
	/** Code HTTP initial observé avant normalisation éventuelle par le transport. */
	initialStatus: number;
	/** URL complète de la requête associée à la réponse mise en cache. */
	url: string;
	/** Corps de réponse sérialisé stocké dans le cache. */
	body: string;
	/** En-têtes HTTP sérialisés sous forme de couples clé/valeur. */
	headers: [string, string][];
}

/**
 * Entrée de cache représentant une valeur métier déjà normalisée par le SDK.
 */
export interface AurionValueCacheEntry<TValue = unknown> {
	/** Discriminant utilisé pour identifier une entrée de valeur métier. */
	kind: "value";
	/** Horodatage Unix en millisecondes de création de l'entrée, utilisé pour le TTL. */
	createdAt?: number;
	/** Valeur métier déjà normalisée à réutiliser sans nouveau parsing. */
	value: TValue;
}

/**
 * Union des formats d'entrée stockables dans un {@link AurionCacheStore}.
 */
export type AurionCacheEntry<TValue = unknown> =
	| AurionTransportCacheEntry
	| AurionValueCacheEntry<TValue>;

/**
 * Backend de cache personnalisable utilisé par la session et le transport.
 */
export interface AurionCacheStore {
	/** Lit une entrée de cache à partir de sa clé stable. */
	get(key: string): Awaitable<AurionCacheEntry | undefined>;
	/** Écrit ou remplace une entrée de cache pour une clé donnée. */
	set(key: string, value: AurionCacheEntry): Awaitable<void>;
	/** Supprime une entrée ciblée, par exemple après expiration. */
	delete(key: string): Awaitable<void>;
	/** Vide entièrement le store de cache. */
	clear(): Awaitable<void>;
}

/**
 * Unité utilisée pour approximer une fenêtre temporelle dans les clés de cache.
 */
export type AurionTimeRangeApproximationUnit = "minute" | "hour" | "day";

/**
 * Politique d'approximation d'une fenêtre temporelle utilisée par le cache.
 */
export interface AurionTimeRangeApproximation {
	/** Unité de découpage de la fenêtre temporelle. */
	unit: AurionTimeRangeApproximationUnit;
	/**
	 * Nombre d'unités composant un bucket.
	 *
	 * Par exemple `15` avec `unit: "minute"` approxime par tranches de 15 minutes.
	 * @default 1
	 */
	step?: number;
}

/**
 * Options d'approximation de fenêtres temporelles par ressource métier.
 */
export interface AurionCacheTimeRangeApproximationOptions {
	/**
	 * Approximation appliquée au planning.
	 *
	 * La fenêtre demandée est élargie au bucket configuré pour favoriser les hits,
	 * puis les événements sont refiltrés sur la fenêtre exacte côté SDK.
	 */
	planning?: AurionTimeRangeApproximation;
}

/**
 * Options de configuration du cache public de l'SDK.
 *
 * `maxAgeMs` définit un TTL commun, tandis que `sessionMaxAgeMs` et
 * `transportMaxAgeMs` permettent de configurer chaque couche séparément.
 */
export interface AurionCacheOptions {
	/** Store à utiliser à la place du cache mémoire par défaut fourni par le SDK. */
	store?: AurionCacheStore;
	/** TTL partagé en millisecondes appliqué aux caches session et transport par défaut. */
	maxAgeMs?: number;
	/** TTL spécifique en millisecondes pour les réponses HTTP mises en cache. */
	transportMaxAgeMs?: number;
	/** TTL spécifique en millisecondes pour les valeurs métier mises en cache par la session. */
	sessionMaxAgeMs?: number;
	/** Approximation optionnelle des fenêtres temporelles utilisées comme clés de cache. */
	timeRangeApproximation?: AurionCacheTimeRangeApproximationOptions;
}

/**
 * Configuration de cache normalisée après résolution des options publiques.
 */
export interface ResolvedAurionCacheConfig {
	/** Store effectif utilisé après normalisation, ou `null` si le cache est désactivé. */
	store: AurionCacheStore | null;
	/** TTL effectif appliqué à la couche transport, s'il existe. */
	transportMaxAgeMs?: number;
	/** TTL effectif appliqué aux valeurs mises en cache par la session, s'il existe. */
	sessionMaxAgeMs?: number;
	/** Taille de bucket appliquée au planning, exprimée en millisecondes. */
	planningTimeRangeApproximationMs?: number;
}

/** Facteurs de conversion des unités d'approximation en millisecondes. */
const TIME_RANGE_APPROXIMATION_UNIT_TO_MS = {
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
} as const satisfies Record<AurionTimeRangeApproximationUnit, number>;

/**
 * Convertit une politique d'approximation en taille de bucket millisecondes.
 * @param approximation Politique à convertir, ou `undefined` si aucune approximation n'est configurée.
 * @returns La taille positive du bucket, ou `undefined` sans politique.
 * @throws {RangeError} Si `step` n'est pas un entier positif.
 */
function resolveTimeRangeApproximationMs(
	approximation: AurionTimeRangeApproximation | undefined,
): number | undefined {
	if (!approximation) {
		return undefined;
	}

	const step = approximation.step ?? 1;
	if (!Number.isInteger(step) || step < 1) {
		throw new RangeError("Aurion cache time range approximation step must be a positive integer.");
	}
	const unitMs = TIME_RANGE_APPROXIMATION_UNIT_TO_MS[approximation.unit];
	if (!unitMs) {
		throw new RangeError("Aurion cache time range approximation unit is invalid.");
	}

	return unitMs * step;
}

function validateCacheTtl(name: string, value: number | undefined): number | undefined {
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new RangeError(`${name} must be a finite, non-negative number.`);
	}
	return value;
}

/**
 * Implémentation mémoire simple du cache fourni par défaut par le SDK.
 */
export class InMemoryAurionCache implements AurionCacheStore {
	private readonly entries = new Map<string, AurionCacheEntry>();

	/**
	 * Lit l'entrée associée à la clé, sans modifier le cache.
	 * @param key Clé stable de l'entrée recherchée.
	 * @returns L'entrée trouvée, ou `undefined` si la clé est absente.
	 */
	get(key: string): AurionCacheEntry | undefined {
		return this.entries.get(key);
	}

	/**
	 * Ajoute ou remplace l'entrée associée à la clé.
	 * @param key Clé stable sous laquelle enregistrer l'entrée.
	 * @param value Entrée de cache à stocker.
	 */
	set(key: string, value: AurionCacheEntry): void {
		this.entries.set(key, value);
	}

	/**
	 * Supprime l'entrée associée à la clé si elle existe.
	 * @param key Clé stable de l'entrée à supprimer.
	 */
	delete(key: string): void {
		this.entries.delete(key);
	}

	/** Supprime toutes les entrées du cache. */
	clear(): void {
		this.entries.clear();
	}
}

/**
 * Détermine si une valeur respecte le contrat d'un {@link AurionCacheStore}.
 * @param cache Valeur à tester, store direct ou configuration de cache.
 * @returns `true` si la valeur implémente toutes les méthodes du store.
 */
export function isAurionCacheStore(
	cache: AurionCacheStore | AurionCacheOptions,
): cache is AurionCacheStore {
	return (
		typeof cache === "object" &&
		cache !== null &&
		"get" in cache &&
		typeof cache.get === "function" &&
		"set" in cache &&
		typeof cache.set === "function" &&
		"delete" in cache &&
		typeof cache.delete === "function" &&
		"clear" in cache &&
		typeof cache.clear === "function"
	);
}

/**
 * Normalise la configuration publique du cache en store et TTL effectifs.
 * @param cache Configuration fournie à la session, ou `undefined` pour désactiver le cache.
 * @returns Store et durées de vie normalisés pour les deux couches de cache.
 * @throws {RangeError} Si l'étape d'approximation temporelle n'est pas un entier positif.
 */
export function resolveAurionCacheConfig(
	cache: boolean | AurionCacheStore | AurionCacheOptions | undefined,
): ResolvedAurionCacheConfig {
	if (!cache) {
		return {
			store: null,
		};
	}

	if (cache === true) {
		return {
			store: new InMemoryAurionCache(),
		};
	}

	if (isAurionCacheStore(cache)) {
		return {
			store: cache,
		};
	}

	return {
		store: cache.store ?? new InMemoryAurionCache(),
		transportMaxAgeMs: validateCacheTtl(
			"transportMaxAgeMs",
			cache.transportMaxAgeMs ?? cache.maxAgeMs,
		),
		sessionMaxAgeMs: validateCacheTtl("sessionMaxAgeMs", cache.sessionMaxAgeMs ?? cache.maxAgeMs),
		planningTimeRangeApproximationMs: resolveTimeRangeApproximationMs(
			cache.timeRangeApproximation?.planning,
		),
	};
}

/**
 * Résout uniquement le store de cache à partir de la configuration publique.
 * @param cache Configuration fournie à la session, ou `undefined` pour désactiver le cache.
 * @returns Le store effectif, ou `null` si le cache est désactivé.
 * @throws {RangeError} Si l'étape d'approximation temporelle configurée est invalide.
 */
export function resolveAurionCacheStore(
	cache: boolean | AurionCacheStore | AurionCacheOptions | undefined,
): AurionCacheStore | null {
	return resolveAurionCacheConfig(cache).store;
}

/**
 * Construit une clé de cache pour une réponse de transport HTTP.
 * @param scope Espace de noms isolant les caches de différentes sessions.
 * @param method Méthode HTTP associée à la requête.
 * @param url URL complète de la ressource.
 * @param body Corps de requête à inclure dans la clé, s'il existe.
 * @returns Clé stable combinant les éléments de la requête.
 */
export function createAurionCacheKey(
	scope: string,
	method: string,
	url: string,
	body?: string,
	variant = "",
): string {
	const baseKey = `${scope}:${method}:${url}:${body ?? ""}`;
	return variant ? `${baseKey}:${variant}` : baseKey;
}

/**
 * Construit une clé de cache pour une valeur métier mise en cache par la session.
 * @param scope Espace de noms isolant les caches de différentes sessions.
 * @param key Identifiant de la valeur métier.
 * @returns Clé stable préfixée pour le cache de valeurs.
 */
export function createAurionValueCacheKey(scope: string, key: string): string {
	return `value:${scope}:${key}`;
}

/**
 * Vérifie le discriminant d'une entrée et affine son type vers le cache transport.
 * @param entry Entrée éventuelle à examiner.
 * @returns `true` uniquement pour une entrée de type `transport`.
 */
export function isAurionTransportCacheEntry(entry: unknown): entry is AurionTransportCacheEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry as Partial<AurionTransportCacheEntry>;
	if (
		candidate.kind !== "transport" ||
		!Number.isInteger(candidate.status) ||
		!Number.isInteger(candidate.initialStatus) ||
		(candidate.status ?? 0) < 100 ||
		(candidate.status ?? 0) > 599 ||
		(candidate.initialStatus ?? 0) < 100 ||
		(candidate.initialStatus ?? 0) > 599 ||
		typeof candidate.url !== "string" ||
		typeof candidate.body !== "string" ||
		!Array.isArray(candidate.headers) ||
		(candidate.createdAt !== undefined && !Number.isFinite(candidate.createdAt))
	) {
		return false;
	}

	try {
		const url = new URL(candidate.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	} catch {
		return false;
	}

	const headersAreValid = candidate.headers.every(
		(header) =>
			Array.isArray(header) &&
			header.length === 2 &&
			typeof header[0] === "string" &&
			typeof header[1] === "string",
	);
	if (!headersAreValid) return false;
	try {
		new Headers(candidate.headers);
		return true;
	} catch {
		return false;
	}
}

/**
 * Vérifie le discriminant d'une entrée et affine son type vers une valeur métier.
 * @param entry Entrée éventuelle à examiner.
 * @returns `true` uniquement pour une entrée de type `value`.
 */
export function isAurionValueCacheEntry(entry: unknown): entry is AurionValueCacheEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry as Partial<AurionValueCacheEntry>;
	return (
		candidate.kind === "value" &&
		"value" in candidate &&
		(candidate.createdAt === undefined || Number.isFinite(candidate.createdAt))
	);
}

/**
 * Indique si une entrée de cache doit être considérée expirée pour un TTL donné.
 *
 * Une entrée sans `createdAt` n'expire pas automatiquement, ce qui préserve la
 * compatibilité avec des stores déjà peuplés avant l'introduction des TTL.
 * @param entry Entrée dont l'ancienneté est évaluée.
 * @param maxAgeMs Durée de vie maximale en millisecondes, ou `undefined` pour désactiver l'expiration.
 * @param now Instant courant en millisecondes Unix, injectable pour les tests.
 * @returns `true` si l'entrée a dépassé sa durée de vie.
 */
export function isAurionCacheEntryExpired(
	entry: AurionCacheEntry,
	maxAgeMs: number | undefined,
	now = Date.now(),
): boolean {
	validateCacheTtl("maxAgeMs", maxAgeMs);
	if (maxAgeMs === undefined || entry.createdAt === undefined) {
		return false;
	}
	if (!Number.isFinite(entry.createdAt) || entry.createdAt > now) {
		return true;
	}

	return now - entry.createdAt > maxAgeMs;
}
