import type { AurionGrade, RawAurionGradeRow } from "../types";

import { normalizeText, parseDateOrThrow, throwParsingError } from "./shared";

const FORM_ID_MARKER = ">chargerSousMenu = function()";

/** Convertit une ligne brute de notes Aurion en objet typé et nettoyé. */
export function toAurionGrade(raw: RawAurionGradeRow): AurionGrade {
	const parser = "toAurionGrade";
	const body = JSON.stringify(raw);

	return {
		date: parseDateOrThrow(body, parser, "date", raw.date, {
			rawDate: raw.date,
		}),
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

/** Extrait l'identifiant de formulaire PrimeFaces utilisé pour la navigation notes. */
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

/** Extrait l'identifiant de datatable PrimeFaces qui porte les notes. */
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

/** Parse les lignes HTML du tableau de notes en structure brute typée. */
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

function extractSpan(cell?: string): string {
	if (!cell) {
		return "";
	}

	const spanMatch = cell.match(/<span[^>]*class="[^"]*preformatted[^"]*"[^>]*>([\s\S]*?)<\/span>/);
	const source = spanMatch?.[1] ?? cell;

	return normalizeText(source);
}
