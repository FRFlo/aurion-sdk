import type { AurionPlanningEvent, AurionPlanningEventDetails } from "../types";

import { decodeHtmlEntities, normalizeText, parseDateOrThrow, throwParsingError } from "./shared";

/**
 * Extrait l'identifiant du widget agenda PrimeFaces de la page Planning.
 *
 * @param body Corps HTML de la page Planning.
 * @returns L'identifiant du composant agenda PrimeFaces.
 * @throws {AurionError} Si le widget agenda ne peut pas être identifié.
 */
export function parseFormIdPlanning(body: string): string {
	const match = body.match(/PrimeFaces\.cw\("Schedule","schedule",\{id:"([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseFormIdPlanning", "Planning schedule widget id not found");
	}

	return match[1];
}

/**
 * Extrait l'identifiant de menu latéral correspondant à l'entrée « Mon Planning ».
 *
 * @param body Corps HTML du menu principal Aurion.
 * @returns L'identifiant PrimeFaces du menu latéral ciblant « Mon Planning ».
 * @throws {AurionError} Si l'entrée « Mon Planning » ne peut pas être résolue.
 */
export function parseSidebarMenuIdForMonPlanning(body: string): string {
	const match = body.match(
		/onclick="[^"]*?PrimeFaces\.addSubmitParam\('form',\{'form:sidebar':'form:sidebar','form:sidebar_menuid':'([^']+)'\}[^"]*?"[^>]*?>[^<]*<span class="ui-menuitem-icon ui-icon fa fa-calendar-alt"><\/span><span class="ui-menuitem-text">Mon Planning<\/span>/,
	);

	if (!match?.[1]) {
		throwParsingError(
			body,
			"parseSidebarMenuIdForMonPlanning",
			"Missing sidebar menu id for Mon Planning",
		);
	}

	return match[1];
}

/**
 * Parse la charge JSON d'événements du planning et valide sa structure.
 *
 * @param body Réponse JSF contenant le payload JSON du planning.
 * @returns Les événements de planning convertis en structures normalisées.
 * @throws {AurionError} Si le payload JSON est absent, invalide ou contient des événements mal formés.
 */
export function parsePlanningEvents(body: string): Array<Omit<AurionPlanningEvent, "getDetails">> {
	const { payload, parsed } = parsePlanningEventsPayload(body);

	if (!Array.isArray(parsed)) {
		throwParsingError(body, "parsePlanningEvents", "Planning payload is not an array", {
			payloadSnippet: payload.slice(0, 280),
		});
	}

	return parsed.map((event, index) => {
		if (!isPlanningEventPayload(event)) {
			throwParsingError(body, "parsePlanningEvents", "Planning event has invalid shape", {
				index,
				event,
				payloadSnippet: payload.slice(0, 280),
			});
		}

		const start = parseDateOrThrow(payload, "parsePlanningEvents", "start", event.start, {
			index,
			eventId: event.id,
		});
		const end = parseDateOrThrow(payload, "parsePlanningEvents", "end", event.end, {
			index,
			eventId: event.id,
		});
		return {
			id: event.id,
			title: event.title,
			start,
			end,
			allDay: event.allDay,
			editable: event.editable,
			type: event.className,
		};
	});
}

function parsePlanningEventsPayload(body: string): { payload: string; parsed: unknown } {
	const trimmedBody = body.trim();
	const directParsed = parsePlanningJsonCandidate(trimmedBody);
	if (directParsed !== null) {
		return directParsed;
	}

	for (const cdata of body.matchAll(/<!\[CDATA\[([\s\S]*?)]]>/g)) {
		const candidate = cdata[1]?.trim();
		if (!candidate?.includes('"events"')) {
			continue;
		}

		const parsed = parsePlanningJsonCandidate(candidate);
		if (parsed !== null) {
			return parsed;
		}
	}

	throwParsingError(body, "parsePlanningEvents", "Planning JSON payload not found");
}

function parsePlanningJsonCandidate(
	candidate: string,
): { payload: string; parsed: unknown } | null {
	if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
		return null;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (Array.isArray(parsed)) {
		return { payload: candidate, parsed };
	}

	if (isRecord(parsed) && Array.isArray(parsed.events)) {
		return { payload: JSON.stringify(parsed.events), parsed: parsed.events };
	}

	return null;
}

/**
 * Parse la réponse partielle JSF qui contient la modale de détails d'un événement.
 *
 * @param body Réponse XML partielle renvoyée par le `eventSelect` PrimeFaces.
 * @param eventId Identifiant de l'événement sélectionné.
 * @returns Les détails complets de l'événement extraits de la modale Aurion.
 * @throws {AurionError} Si la modale ou un champ obligatoire ne peut pas être extrait.
 */
export function parseEventDetails(body: string, eventId: string): AurionPlanningEventDetails {
	const modal = extractPartialUpdate(body, "form:modaleDetail");
	const start = extractDateField(body, modal, "Du");
	const end = extractDateField(body, modal, "Au");

	return {
		eventId,
		start,
		end,
		status: extractField(modal, "Statut"),
		subject: extractField(modal, "Matière"),
		teachingType: extractField(modal, "Type d'enseignement"),
		description: extractField(modal, "Description"),
		isExam: extractField(modal, "Est une épreuve")?.toLowerCase() === "oui",
		teachers: parsePeopleTable(modal, "Intervenants"),
		students: parsePeopleTable(modal, "Apprenants"),
		groups: parseCodeNameTable(modal, "Groupes"),
		courses: parseCoursesTable(modal, "Cours"),
		resources: parseCodeNameTable(modal, "Ressources"),
	};
}

interface PlanningEventPayload {
	id: string;
	title: string;
	start: unknown;
	end: unknown;
	allDay: boolean;
	editable: boolean;
	className: string;
}

function isPlanningEventPayload(value: unknown): value is PlanningEventPayload {
	if (!isRecord(value)) {
		return false;
	}

	return (
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		"start" in value &&
		"end" in value &&
		typeof value.allDay === "boolean" &&
		typeof value.editable === "boolean" &&
		typeof value.className === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Vérifie qu'une valeur inconnue respecte la forme d'un événement planning Aurion.
 *
 * @param value Valeur arbitraire à tester.
 * @returns `true` si la valeur respecte la forme publique d'un événement de planning Aurion.
 */
export function isPlanningEvent(value: unknown): value is AurionPlanningEvent {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.id === "string" &&
		typeof candidate.title === "string" &&
		candidate.start instanceof Date &&
		!Number.isNaN(candidate.start.getTime()) &&
		candidate.end instanceof Date &&
		!Number.isNaN(candidate.end.getTime()) &&
		typeof candidate.allDay === "boolean" &&
		typeof candidate.editable === "boolean" &&
		typeof candidate.type === "string" &&
		typeof candidate.getDetails === "function"
	);
}

function extractPartialUpdate(body: string, updateId: string): string {
	const escapedUpdateId = escapeRegExp(updateId);
	const match = body.match(
		new RegExp(
			`<update\\s+id=["']${escapedUpdateId}["']>\\s*<!\\[CDATA\\[([\\s\\S]*?)]]>\\s*</update>`,
		),
	);

	if (!match?.[1]) {
		throwParsingError(body, "parseEventDetails", "Event details modal update not found", {
			updateId,
		});
	}

	return match[1];
}

function extractField(modal: string, label: string): string | null {
	const rowMatch = findLabeledValue(modal, label);
	if (!rowMatch) {
		return null;
	}

	return normalizeNullableText(rowMatch);
}

function extractDateField(body: string, modal: string, label: "Du" | "Au"): Date {
	const row = findTableRowByLabel(modal, label);
	if (!row) {
		throwParsingError(body, "parseEventDetails", `Missing ${label} date row`);
	}

	const cells = extractCells(row);
	const date = cells[1];
	const time = cells[3];
	if (!date || !time) {
		throwParsingError(body, "parseEventDetails", `Incomplete ${label} date row`, {
			cells,
		});
	}

	return parseFrenchDateText(body, `${date} ${time}`, label);
}

function parsePeopleTable(
	modal: string,
	tabLabel: string,
): Array<{ lastName: string; firstName: string }> {
	return parseTabRows(modal, tabLabel)
		.map((row) => ({
			lastName: row.nom ?? "",
			firstName: row.prenom ?? "",
		}))
		.filter((person) => person.lastName !== "" || person.firstName !== "");
}

function parseCodeNameTable(
	modal: string,
	tabLabel: string,
): Array<{ code: string; name: string }> {
	return parseTabRows(modal, tabLabel)
		.map((row) => ({
			code: row.code ?? "",
			name: row.libelle ?? "",
		}))
		.filter((item) => item.code !== "" || item.name !== "");
}

function parseCoursesTable(
	modal: string,
	tabLabel: string,
): Array<{ code: string; course: string; module: string }> {
	return parseTabRows(modal, tabLabel)
		.map((row) => ({
			code: row.code ?? "",
			course: row.cours ?? "",
			module: row.module ?? "",
		}))
		.filter((course) => course.code !== "" || course.course !== "" || course.module !== "");
}

function parseTabRows(modal: string, tabLabel: string): Array<Record<string, string>> {
	const panelId = extractTabPanelId(modal, tabLabel);
	if (!panelId) {
		return [];
	}

	const panel = extractElementBlockById(modal, panelId, "div");
	if (!panel) {
		return [];
	}

	const table = extractElementBlock(panel, "table");
	if (!table) {
		return [];
	}

	const headers = Array.from(table.matchAll(/<th\b[\s\S]*?<\/th>/g)).map((match) =>
		normalizeHeaderText(match[0]),
	);
	const bodyMatch = table.match(/<tbody\b[\s\S]*?>([\s\S]*?)<\/tbody>/);
	if (!bodyMatch?.[1]) {
		return [];
	}

	return Array.from(bodyMatch[1].matchAll(/<tr\b[\s\S]*?<\/tr>/g)).map((match) => {
		const cells = extractCells(match[0]);
		const row: Record<string, string> = {};

		for (const [index, header] of headers.entries()) {
			row[header] = cells[index] ?? "";
		}

		return row;
	});
}

function extractTabPanelId(modal: string, tabLabel: string): string | null {
	const escapedLabel = escapeRegExp(tabLabel);
	const match = modal.match(
		new RegExp(
			`<a\\s+href=["']#([^"']+)["'][^>]*>\\s*${escapedLabel}(?:\\s*\\([^)]*\\))?\\s*</a>`,
			"i",
		),
	);

	return match?.[1] ?? null;
}

function findLabeledValue(modal: string, label: string): string | null {
	const escapedLabel = escapeRegExp(label);
	const match = modal.match(
		new RegExp(
			`<div\\s+class=["'][^"']*ui-grid-row[^"']*["'][^>]*>[\\s\\S]*?<span[^>]*>\\s*${escapedLabel}\\s*</span>[\\s\\S]*?</div>\\s*<div\\s+class=["'][^"']*ui-panelgrid-cell[^"']*["'][^>]*>([\\s\\S]*?)</div>`,
			"i",
		),
	);

	return match?.[1] ?? null;
}

function findTableRowByLabel(modal: string, label: string): string | null {
	const rows = modal.match(/<tr\b[\s\S]*?<\/tr>/g) ?? [];

	return rows.find((row) => extractCells(row)[0] === label) ?? null;
}

function extractCells(row: string): string[] {
	return Array.from(row.matchAll(/<t[dh]\b[\s\S]*?>([\s\S]*?)<\/t[dh]>/g)).map((match) =>
		normalizeText(match[1] ?? ""),
	);
}

function extractElementBlockById(markup: string, id: string, tagName: string): string | null {
	const escapedId = escapeRegExp(id);
	const openingTag = markup.match(
		new RegExp(`<${tagName}\\b[^>]*id=["']${escapedId}["'][^>]*>`, "i"),
	);
	if (openingTag?.index === undefined) {
		return null;
	}

	return extractElementBlock(markup.slice(openingTag.index), tagName);
}

function extractElementBlock(markup: string, tagName: string): string | null {
	const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
	let depth = 0;
	let startIndex: number | null = null;

	for (const match of markup.matchAll(tagPattern)) {
		const token = match[0];
		const index = match.index ?? 0;
		if (!token.startsWith("</")) {
			if (depth === 0) {
				startIndex = index;
			}
			depth += 1;
		} else {
			depth -= 1;
			if (depth === 0 && startIndex !== null) {
				return markup.slice(startIndex, index + token.length);
			}
		}
	}

	return null;
}

function parseFrenchDateText(body: string, value: string, field: string): Date {
	const normalized = normalizeText(value).toLowerCase();
	const match = normalized.match(
		/(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+([a-zéû]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/,
	);

	if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
		throwParsingError(body, "parseEventDetails", `Unparseable ${field} date`, {
			value,
		});
	}

	const month = frenchMonthToIndex(match[2]);
	if (month === null) {
		throwParsingError(body, "parseEventDetails", `Unknown ${field} month`, {
			month: match[2],
			value,
		});
	}

	const date = new Date(
		Number.parseInt(match[3], 10),
		month,
		Number.parseInt(match[1], 10),
		Number.parseInt(match[4], 10),
		Number.parseInt(match[5], 10),
	);

	if (Number.isNaN(date.getTime())) {
		throwParsingError(body, "parseEventDetails", `Invalid ${field} date`, {
			value,
		});
	}

	return date;
}

function frenchMonthToIndex(month: string): number | null {
	const months: Record<string, number> = {
		janvier: 0,
		fevrier: 1,
		février: 1,
		mars: 2,
		avril: 3,
		mai: 4,
		juin: 5,
		juillet: 6,
		aout: 7,
		août: 7,
		septembre: 8,
		octobre: 9,
		novembre: 10,
		decembre: 11,
		décembre: 11,
	};

	return months[month] ?? null;
}

function normalizeNullableText(value: string): string | null {
	const normalized = normalizeText(value);

	return normalized === "" ? null : normalized;
}

function normalizeHeaderText(value: string): string {
	return decodeHtmlEntities(normalizeText(value))
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
