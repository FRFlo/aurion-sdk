import { type AurionError, createAurionError } from "../errors";

const MENU_ID_KEYWORD = ">Mes notes</span>";

export interface ParsingErrorDetails {
	parser: string;
	reason: string;
	except: string;
	context?: Record<string, unknown>;
}

/** Extrait la valeur `javax.faces.ViewState` d'une réponse HTML Aurion. */
export function parseViewState(body: string): string {
	const match = body.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseViewState", "Missing javax.faces.ViewState input");
	}

	return match[1];
}

/** Extrait la valeur cachée `form:idInit` utilisée dans les POST JSF. */
export function parseIdInit(body: string): string {
	const match = body.match(/<input[^>]*name="form:idInit"[^>]*value="([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseIdInit", "Missing form:idInit hidden input");
	}

	return match[1];
}

/**
 * Résout l'identifiant de menu latéral PrimeFaces à partir d'un mot-clé de section.
 */
export function parseMenuId(body: string, keyword = MENU_ID_KEYWORD): string {
	const keywordIndex = body.indexOf(keyword);
	if (keywordIndex === -1) {
		throwParsingError(body, "parseMenuId", "Keyword not found in sidebar response", {
			keyword,
		});
	}

	const searchStart = Math.max(0, keywordIndex - 400);
	const snippet = body.slice(searchStart, keywordIndex + keyword.length);

	const matches = Array.from(snippet.matchAll(/form:sidebar_menuid['"]?\s*:\s*['"]([^'"]+)['"]/g));

	if (matches.length === 0) {
		throwParsingError(body, "parseMenuId", "Unable to extract sidebar menu id", {
			keyword,
			snippet,
		});
	}

	const lastMatch = matches.at(-1);
	if (!lastMatch?.[1]) {
		throwParsingError(body, "parseMenuId", "Extracted sidebar menu id is empty", {
			keyword,
			snippet,
		});
	}

	return lastMatch[1];
}

/** Nettoie un fragment HTML en texte brut compact et décodé. */
export function normalizeText(input: string): string {
	const withoutTags = input.replaceAll(/<[^>]*>/g, " ");
	const decoded = decodeHtmlEntities(withoutTags);

	return decoded.replaceAll(/\s+/g, " ").trim();
}

/** Décode les entités HTML usuelles rencontrées dans les réponses Aurion. */
export function decodeHtmlEntities(input: string): string {
	return input
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
}

/**
 * Lance une `AurionError` standardisée pour homogénéiser les erreurs de parsing.
 */
export function throwParsingError(
	body: string,
	parser: string,
	reason: string,
	context?: Record<string, unknown>,
): never {
	const details: ParsingErrorDetails = {
		parser,
		reason,
		except: body.slice(0, 280),
		context,
	};

	throw createAurionError(
		"AURION_PARSING_ERROR",
		`Erreur de parsing Aurion (${parser}): ${reason}`,
		details,
	) satisfies AurionError;
}

/**
 * Convertit une valeur date-like en objet `Date` valide ou déclenche une erreur de parsing.
 */
export function parseDateOrThrow(
	body: string,
	parser: string,
	field: string,
	value: unknown,
	context?: Record<string, unknown>,
): Date {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value: "Invalid Date",
				...context,
			});
		}

		return new Date(value.getTime());
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		const fromNumber = new Date(value);
		if (Number.isNaN(fromNumber.getTime())) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		return fromNumber;
	}

	if (typeof value !== "string") {
		throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
			field,
			value,
			...context,
		});
	}

	const normalized = value.trim();
	if (!normalized) {
		throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
			field,
			value,
			...context,
		});
	}

	const frenchDateMatch = normalized.match(
		/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
	);

	if (frenchDateMatch) {
		const dayRaw = frenchDateMatch[1];
		const monthRaw = frenchDateMatch[2];
		const yearRaw = frenchDateMatch[3];
		if (!dayRaw || !monthRaw || !yearRaw) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		const day = Number.parseInt(dayRaw, 10);
		const month = Number.parseInt(monthRaw, 10);
		const parsedYear = Number.parseInt(yearRaw, 10);
		const year = yearRaw.length === 2 ? 2000 + parsedYear : parsedYear;
		const hours = frenchDateMatch[4] ? Number.parseInt(frenchDateMatch[4], 10) : 0;
		const minutes = frenchDateMatch[5] ? Number.parseInt(frenchDateMatch[5], 10) : 0;
		const seconds = frenchDateMatch[6] ? Number.parseInt(frenchDateMatch[6], 10) : 0;

		if (hours > 23 || minutes > 59 || seconds > 59) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
		if (
			date.getFullYear() !== year ||
			date.getMonth() !== month - 1 ||
			date.getDate() !== day ||
			date.getHours() !== hours ||
			date.getMinutes() !== minutes ||
			date.getSeconds() !== seconds
		) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		return date;
	}

	const asNumber = Number(normalized);
	if (Number.isFinite(asNumber) && /^-?\d+(?:\.\d+)?$/.test(normalized)) {
		const numericDate = new Date(asNumber);
		if (Number.isNaN(numericDate.getTime())) {
			throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
				field,
				value,
				...context,
			});
		}

		return numericDate;
	}

	const parsed = new Date(normalized);
	if (Number.isNaN(parsed.getTime())) {
		throwParsingError(body, parser, `Unparseable date value for field "${field}"`, {
			field,
			value,
			...context,
		});
	}

	return parsed;
}
