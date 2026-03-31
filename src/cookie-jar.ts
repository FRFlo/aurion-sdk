/** Cookie HTTP stocké avec les attributs utiles au renvoi conditionnel. */
interface StoredCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	expiresAt: number | null;
}

const DEFAULT_COOKIE_PATH = "/";

/**
 * Stockage mémoire minimaliste des cookies de session Aurion.
 */
export class InMemoryCookieJar {
	private readonly cookies = new Map<string, StoredCookie>();

	/**
	 * Lit les Set-Cookie d'une réponse et met à jour le stockage interne.
	 * Retourne le nombre d'en-têtes Set-Cookie rencontrés.
	 */
	ingestResponseCookies(headers: Headers, requestUrl: URL): number {
		const setCookies = getSetCookieHeaders(headers);

		for (const setCookie of setCookies) {
			const parsedCookie = parseSetCookie(setCookie, requestUrl);
			if (!parsedCookie) {
				continue;
			}

			const key = cookieKey(parsedCookie);
			if (isExpired(parsedCookie)) {
				this.cookies.delete(key);
				continue;
			}

			this.cookies.set(key, parsedCookie);
		}

		return setCookies.length;
	}

	/** Construit l'en-tête `Cookie` applicable pour une URL cible. */
	toRequestCookieHeader(targetUrl: URL): string | undefined {
		const now = Date.now();
		const entries: StoredCookie[] = [];

		for (const [key, cookie] of this.cookies) {
			if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
				this.cookies.delete(key);
				continue;
			}

			if (!shouldSendCookie(cookie, targetUrl)) {
				continue;
			}

			entries.push(cookie);
		}

		if (entries.length === 0) {
			return undefined;
		}

		entries.sort((left, right) => right.path.length - left.path.length);

		return entries.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
	}

	/** Indique si au moins un cookie est actuellement stocké. */
	hasCookies(): boolean {
		return this.cookies.size > 0;
	}
}

/** Extrait les valeurs `Set-Cookie`, y compris sur les implémentations étendues. */
export function getSetCookieHeaders(headers: Headers): string[] {
	const extendedHeaders = headers as Headers & {
		getSetCookie?: () => string[];
	};

	if (typeof extendedHeaders.getSetCookie === "function") {
		return extendedHeaders.getSetCookie();
	}

	const combined = headers.get("set-cookie");
	if (!combined) {
		return [];
	}

	return splitCombinedSetCookieHeader(combined);
}

/** Découpe un en-tête Set-Cookie combiné en cookies individuels. */
function splitCombinedSetCookieHeader(value: string): string[] {
	const cookies: string[] = [];
	let start = 0;
	let inExpiresAttribute = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];

		if (!inExpiresAttribute && value.slice(index, index + 8).toLowerCase() === "expires=") {
			inExpiresAttribute = true;
			index += 7;
			continue;
		}

		if (inExpiresAttribute && character === ";") {
			inExpiresAttribute = false;
			continue;
		}

		if (!inExpiresAttribute && character === ",") {
			const current = value.slice(start, index).trim();
			if (current) {
				cookies.push(current);
			}
			start = index + 1;
		}
	}

	const trailingCookie = value.slice(start).trim();
	if (trailingCookie) {
		cookies.push(trailingCookie);
	}

	return cookies;
}

/** Analyse une ligne Set-Cookie en objet exploitable par le jar. */
function parseSetCookie(setCookie: string, requestUrl: URL): StoredCookie | null {
	const segments = setCookie
		.split(";")
		.map((segment) => segment.trim())
		.filter(Boolean);

	const [nameValue, ...attributes] = segments;
	if (!nameValue) {
		return null;
	}

	const separator = nameValue.indexOf("=");
	if (separator <= 0) {
		return null;
	}

	const name = nameValue.slice(0, separator).trim();
	const value = nameValue.slice(separator + 1).trim();
	if (!name) {
		return null;
	}

	const parsedCookie: StoredCookie = {
		name,
		value,
		domain: requestUrl.hostname.toLowerCase(),
		path: defaultPathFromUrl(requestUrl),
		secure: false,
		expiresAt: null,
	};

	for (const attribute of attributes) {
		const [rawKey, ...rawValueParts] = attribute.split("=");
		const key = rawKey?.trim().toLowerCase();
		const attributeValue = rawValueParts.join("=").trim();

		switch (key) {
			case "domain": {
				if (attributeValue) {
					parsedCookie.domain = attributeValue.replace(/^\./, "").toLowerCase();
				}
				break;
			}
			case "path": {
				parsedCookie.path = attributeValue || DEFAULT_COOKIE_PATH;
				break;
			}
			case "secure": {
				parsedCookie.secure = true;
				break;
			}
			case "max-age": {
				const seconds = Number.parseInt(attributeValue, 10);
				if (Number.isFinite(seconds)) {
					parsedCookie.expiresAt = Date.now() + seconds * 1000;
				}
				break;
			}
			case "expires": {
				const expiresAt = Date.parse(attributeValue);
				if (Number.isFinite(expiresAt)) {
					parsedCookie.expiresAt = expiresAt;
				}
				break;
			}
			default:
				break;
		}
	}

	return parsedCookie;
}

/** Déduit le path par défaut d'un cookie à partir de l'URL de requête. */
function defaultPathFromUrl(url: URL): string {
	if (!url.pathname || !url.pathname.startsWith("/")) {
		return DEFAULT_COOKIE_PATH;
	}

	const lastSlash = url.pathname.lastIndexOf("/");
	if (lastSlash <= 0) {
		return DEFAULT_COOKIE_PATH;
	}

	return url.pathname.slice(0, lastSlash);
}

/** Génère une clé stable pour indexer un cookie dans la map. */
function cookieKey(cookie: StoredCookie): string {
	return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

/** Vérifie si un cookie est expiré au moment de l'évaluation. */
function isExpired(cookie: StoredCookie): boolean {
	return cookie.expiresAt !== null && cookie.expiresAt <= Date.now();
}

/** Vérifie les règles domain/path/secure avant envoi d'un cookie. */
function shouldSendCookie(cookie: StoredCookie, targetUrl: URL): boolean {
	const host = targetUrl.hostname.toLowerCase();
	const pathname = targetUrl.pathname || DEFAULT_COOKIE_PATH;

	if (!domainMatches(cookie.domain, host)) {
		return false;
	}

	if (!pathname.startsWith(cookie.path)) {
		return false;
	}

	if (cookie.secure && targetUrl.protocol !== "https:") {
		return false;
	}

	return true;
}

/** Applique la correspondance de domaine pour les cookies hôtes et sous-domaines. */
function domainMatches(cookieDomain: string, requestHost: string): boolean {
	return requestHost === cookieDomain || requestHost.endsWith(`.${cookieDomain}`);
}
