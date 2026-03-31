import { type AurionError, createAurionError } from "./errors";

import type { AurionGrade, RawAurionGradeRow } from "./types";

/** Détails contextualisés renvoyés dans les erreurs de parsing HTML. */
interface ParsingErrorDetails {
	parser: string;
	reason: string;
	except: string;
	context?: Record<string, unknown>;
}

const FORM_ID_MARKER = ">chargerSousMenu = function()";
const MENU_ID_KEYWORD = ">Mes notes</span>";

/** Convertit une ligne brute Aurion en objet de note typé et nettoyé. */
export function toAurionGrade(raw: RawAurionGradeRow): AurionGrade {
	return {
		date: raw.date.trim(),
		code: raw.code.trim(),
		name: raw.name.trim(),
		grade: parseNumericField(raw.grade),
		coefficient: parseNumericField(raw.coefficient),
		average: parseNumericField(raw.average),
		min: parseNumericField(raw.min),
		max: parseNumericField(raw.max),
		median: parseNumericField(raw.median),
		standardDeviation: parseNumericField(raw.standardDeviation),
		comment: raw.comment.trim() || null,
	};
}

/** Analyse une valeur numérique potentiellement bruitée du HTML Aurion. */
function parseNumericField(value: string): number | null {
	const normalized = value.replaceAll(/\s+/g, "").replace(",", ".");
	if (!normalized) {
		return null;
	}

	const numberMatch = normalized.match(/-?\d+(?:\.\d+)?/);
	if (!numberMatch?.[0]) {
		return null;
	}

	const parsed = Number.parseFloat(numberMatch[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Extrait la valeur JSF `ViewState` nécessaire aux POST suivants. */
export function parseViewState(body: string): string {
	const match = body.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseViewState", "Missing javax.faces.ViewState input");
	}

	return match[1];
}

/** Extrait l'identifiant de source PrimeFaces du formulaire principal. */
export function parseFormId(body: string): string {
	const markerIndex = body.indexOf(FORM_ID_MARKER);
	if (markerIndex === -1) {
		throwParsingError(body, "parseFormId", "Missing chargerSousMenu script marker");
	}

	const snippet = body.slice(markerIndex, markerIndex + 500);
	const from = "{PrimeFaces.ab({s:";
	const to = ",f:";
	const idxFrom = snippet.indexOf(from);
	const idxTo = snippet.indexOf(to);

	if (idxFrom === -1 || idxTo === -1 || idxTo <= idxFrom + from.length) {
		throwParsingError(body, "parseFormId", "PrimeFaces form source id not found", {
			snippet,
		});
	}

	const raw = snippet.slice(idxFrom + from.length, idxTo).replaceAll('"', "");
	if (!raw) {
		throwParsingError(body, "parseFormId", "PrimeFaces form source id is empty", {
			snippet,
		});
	}

	return raw;
}

/** Extrait l'identifiant `form:idInit` depuis le HTML de navigation. */
export function parseIdInit(body: string): string {
	// L'ordre des attributs peut varier selon le HTML servi en production.
	// Exemple: <input id="form:idInit" type="hidden" name="form:idInit" value="webscolaapp.MainMenuPage_..." />
	const match = body.match(/<input[^>]*name="form:idInit"[^>]*value="([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseIdInit", "Missing form:idInit hidden input");
	}

	return match[1];
}

/** Extrait l'identifiant du menu latéral associé à la section des notes. */
export function parseMenuId(body: string, keyword = MENU_ID_KEYWORD): string {
	const keywordIndex = body.indexOf(keyword);
	if (keywordIndex === -1) {
		throwParsingError(body, "parseMenuId", "Keyword not found in sidebar response", {
			keyword,
		});
	}

	const searchStart = Math.max(0, keywordIndex - 400);
	const snippet = body.slice(searchStart, keywordIndex + keyword.length);

	// Cherche toutes les occurrences du motif menu dans l'extrait ciblé.
	const matches = Array.from(snippet.matchAll(/form:sidebar_menuid['"]?\s*:\s*['"]([^'"]+)['"]/g));

	if (matches.length === 0) {
		throwParsingError(body, "parseMenuId", "Unable to extract sidebar menu id", {
			keyword,
			snippet,
		});
	}

	// Le bon identifiant est celui le plus proche du mot-clé, donc le dernier trouvé.
	const lastMatch = matches.at(-1);
	if (!lastMatch?.[1]) {
		throwParsingError(body, "parseMenuId", "Extracted sidebar menu id is empty", {
			keyword,
			snippet,
		});
	}

	return lastMatch[1];
}

/** Extrait l'identifiant du datatable PrimeFaces contenant les notes. */
export function parseFormIdGrade(body: string): string {
	const directMatch = body.match(
		/<div class="EmptyBox10"><\/div><div id="form:([^"]+)" class="ui-datatable ui-widget/,
	);
	if (directMatch?.[1]) {
		return directMatch[1];
	}

	const anchor = "Date Ascending";
	const anchorIndex = body.indexOf(anchor);
	if (anchorIndex === -1) {
		throwParsingError(body, "parseFormIdGrade", "Grades datatable anchor not found", {
			anchor,
		});
	}

	const snippet = body.slice(Math.max(0, anchorIndex - 500), anchorIndex + 50);
	const fallbackMatch = snippet.match(/<div id="form:([^"]+)" class="ui-datatable ui-widget/);
	if (!fallbackMatch?.[1]) {
		throwParsingError(body, "parseFormIdGrade", "Unable to extract grades datatable id", {
			snippet,
		});
	}

	return fallbackMatch[1];
}

/** Parse le fragment HTML renvoyé par PrimeFaces en lignes de notes brutes. */
export function parseGrades(body: string): RawAurionGradeRow[] {
	const rows = body.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
	if (!rows) {
		throwParsingError(body, "parseGrades", "No table rows found in grades response");
	}

	const parsedRows: RawAurionGradeRow[] = [];

	for (const row of rows) {
		const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
		if (cells.length === 0) {
			continue;
		}

		const parsed: RawAurionGradeRow = {
			date: extractSpan(cells[0]),
			code: extractSpan(cells[1]),
			name: extractSpan(cells[2]),
			grade: extractSpan(cells[3]),
			coefficient: extractSpan(cells[4]),
			average: extractSpan(cells[5]),
			min: extractSpan(cells[6]),
			max: extractSpan(cells[7]),
			median: extractSpan(cells[8]),
			standardDeviation: extractSpan(cells[9]),
			comment: extractSpan(cells[10]),
		};

		if (Object.values(parsed).every((value) => value.length === 0)) {
			continue;
		}

		parsedRows.push(parsed);
	}

	if (parsedRows.length === 0) {
		throwParsingError(body, "parseGrades", "No grade row with extractable cells was found");
	}

	return parsedRows;
}

/** Extrait le texte utile d'une cellule HTML de note. */
function extractSpan(cell?: string): string {
	if (!cell) {
		return "";
	}

	const spanMatch = cell.match(/<span[^>]*class="[^"]*preformatted[^"]*"[^>]*>([\s\S]*?)<\/span>/);
	const source = spanMatch?.[1] ?? cell;

	return normalizeText(source);
}

/** Supprime les balises et normalise les espaces d'un texte HTML. */
function normalizeText(input: string): string {
	const withoutTags = input.replaceAll(/<[^>]*>/g, " ");
	const decoded = decodeHtmlEntities(withoutTags);

	return decoded.replaceAll(/\s+/g, " ").trim();
}

/** Décode les entités HTML les plus fréquentes rencontrées dans Aurion. */
function decodeHtmlEntities(input: string): string {
	return input
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
}

/** Construit puis lève une erreur de parsing homogène et contextualisée. */
function throwParsingError(
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
