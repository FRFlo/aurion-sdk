import type { AurionAbsence, RawAurionAbsenceRow } from "../types";

import { normalizeText, throwParsingError } from "./shared";

/** Convertit une ligne brute d'absence en objet SDK normalisé. */
export function toAurionAbsence(raw: RawAurionAbsenceRow): AurionAbsence {
	return {
		date: raw.date.trim(),
		type: raw.type.trim(),
		duration: raw.duration.trim(),
		time: raw.time.trim(),
		class: raw.class.trim(),
		teacher: raw.teacher.trim(),
	};
}

/** Parse le tableau HTML des absences en lignes brutes typées. */
export function parseAbsences(body: string): RawAurionAbsenceRow[] {
	const absenceRows = body.match(/<tr[^>]*data-ri="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g) ?? [];

	if (absenceRows.length === 0) {
		const hasAbsenceTableStructure =
			body.includes("ui-datatable") ||
			body.includes('role="grid"') ||
			body.includes("ui-datatable-data") ||
			body.includes("MesAbsences") ||
			/<tbody[^>]*>/.test(body);

		if (hasAbsenceTableStructure) {
			return [];
		}

		throwParsingError(body, "parseAbsences", "Absences table structure is missing");
	}

	const parsedRows: RawAurionAbsenceRow[] = [];

	for (const row of absenceRows) {
		const cells = Array.from(row.matchAll(/<td[^>]*role="gridcell"[^>]*>([\s\S]*?)<\/td>/g), (match) => {
			const cellContent = match[1];
			if (typeof cellContent !== "string") {
				throwParsingError(body, "parseAbsences", "Absence row cell extraction failed", {
					rowSnippet: row.slice(0, 220),
				});
			}

			return normalizeText(cellContent);
		});

		if (cells.length === 0) {
			continue;
		}

		if (cells.length < 6) {
			throwParsingError(body, "parseAbsences", "Absence row has unexpected number of cells", {
				cellCount: cells.length,
				rowSnippet: row.slice(0, 220),
			});
		}

		const [date, type, duration, time, className, teacher] = cells;
		if (
			typeof date !== "string" ||
			typeof type !== "string" ||
			typeof duration !== "string" ||
			typeof time !== "string" ||
			typeof className !== "string" ||
			typeof teacher !== "string"
		) {
			throwParsingError(body, "parseAbsences", "Absence row extracted cells are invalid", {
				cellCount: cells.length,
				rowSnippet: row.slice(0, 220),
			});
		}

		const parsed: RawAurionAbsenceRow = {
			date,
			type,
			duration,
			time,
			class: className,
			teacher,
		};

		if (Object.values(parsed).every((value) => value.length === 0)) {
			continue;
		}

		parsedRows.push(parsed);
	}

	return parsedRows;
}
