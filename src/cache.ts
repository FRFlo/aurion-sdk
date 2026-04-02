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
}

/**
 * Implémentation mémoire simple du cache fourni par défaut par le SDK.
 */
export class InMemoryAurionCache implements AurionCacheStore {
	private readonly entries = new Map<string, AurionCacheEntry>();

	get(key: string): AurionCacheEntry | undefined {
		return this.entries.get(key);
	}

	set(key: string, value: AurionCacheEntry): void {
		this.entries.set(key, value);
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}

/**
 * Détermine si une valeur respecte le contrat d'un {@link AurionCacheStore}.
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
		transportMaxAgeMs: cache.transportMaxAgeMs ?? cache.maxAgeMs,
		sessionMaxAgeMs: cache.sessionMaxAgeMs ?? cache.maxAgeMs,
	};
}

/**
 * Résout uniquement le store de cache à partir de la configuration publique.
 */
export function resolveAurionCacheStore(
	cache: boolean | AurionCacheStore | AurionCacheOptions | undefined,
): AurionCacheStore | null {
	return resolveAurionCacheConfig(cache).store;
}

/**
 * Construit une clé de cache pour une réponse de transport HTTP.
 */
export function createAurionCacheKey(
	scope: string,
	method: string,
	url: string,
	body?: string,
): string {
	return `${scope}:${method}:${url}:${body ?? ""}`;
}

/**
 * Construit une clé de cache pour une valeur métier mise en cache par la session.
 */
export function createAurionValueCacheKey(scope: string, key: string): string {
	return `value:${scope}:${key}`;
}

/**
 * Vérifie qu'une entrée de cache correspond à une réponse de transport.
 */
export function isAurionTransportCacheEntry(
	entry: AurionCacheEntry | undefined,
): entry is AurionTransportCacheEntry {
	return entry?.kind === "transport";
}

/**
 * Vérifie qu'une entrée de cache correspond à une valeur métier de session.
 */
export function isAurionValueCacheEntry(
	entry: AurionCacheEntry | undefined,
): entry is AurionValueCacheEntry {
	return entry?.kind === "value";
}

/**
 * Indique si une entrée de cache doit être considérée expirée pour un TTL donné.
 *
 * Une entrée sans `createdAt` n'expire pas automatiquement, ce qui préserve la
 * compatibilité avec des stores déjà peuplés avant l'introduction des TTL.
 */
export function isAurionCacheEntryExpired(
	entry: AurionCacheEntry,
	maxAgeMs: number | undefined,
	now = Date.now(),
): boolean {
	if (maxAgeMs === undefined || entry.createdAt === undefined) {
		return false;
	}

	return now - entry.createdAt > maxAgeMs;
}
