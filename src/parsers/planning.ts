import type { AurionPlanningEvent, AurionPlanningEventDetails } from "../types";

import {
	parseDateOrThrow,
	throwParsingError,
	extractElementBlocks,
	stripTags,
	normalizeWhitespace,
} from "./shared";

function escapeRegExp(input: string): string {
	return input.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeaderText(input: string): string {
	return input.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();
}

function extractTabPanelId(html: string, tabLabel: string): string | null {
	const navMatch = html.match(/<ul[^>]*class="[^"]*\bui-tabs-nav\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
	if (!navMatch?.[1]) {
		return null;
	}

	for (const link of navMatch[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
		const href = link[1] ?? "";
		const label = normalizeWhitespace(stripTags(link[2] ?? ""));
		if (
			!href.startsWith("#") ||
			!normalizeHeaderText(label).startsWith(normalizeHeaderText(tabLabel))
		) {
			continue;
		}

		return href.slice(1);
	}

	return null;
}

function extractElementBlockById(body: string, tagName: string, id: string): string | null {
	const openTagPattern = new RegExp(`<${tagName}\\b[^>]*\\bid="${escapeRegExp(id)}"[^>]*>`, "i");
	const openTagMatch = openTagPattern.exec(body);
	if (!openTagMatch) {
		return null;
	}

	const startIndex = openTagMatch.index + openTagMatch[0].length;

	let depth = 1;
	let cursor = startIndex;

	while (depth > 0) {
		const remainder = body.slice(cursor);
		const nextOpen = remainder.match(new RegExp(`<${tagName}\\b[^>]*>`, "i"));
		const nextClose = remainder.match(new RegExp(`</${tagName}>`, "i"));
		if (!nextClose || nextClose.index === undefined) {
			return null;
		}
		const closeIndex = nextClose.index;

		if (nextOpen?.index !== undefined && nextOpen.index < closeIndex) {
			depth += 1;
			cursor += nextOpen.index + nextOpen[0].length;
			continue;
		}

		depth -= 1;
		cursor += closeIndex + nextClose[0].length;
		if (depth === 0) {
			return body.slice(openTagMatch.index, cursor);
		}
	}

	return null;
}

function frenchMonthToIndex(monthText: string): number | null {
	const normalized = normalizeWhitespace(monthText).toLowerCase();
	const aliases: Record<string, number> = {
		janvier: 0,
		fevrier: 1,
		février: 1,
		fvrier: 1,
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
		dcembre: 11,
	};

	return aliases[normalized] ?? null;
}

function parseFrenchDateText(dateText: string, timeText: string): Date {
	const normalizedDateText = normalizeWhitespace(dateText)
		.toLowerCase()
		.replace(/^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+/i, "");
	const normalizedTimeText = normalizeWhitespace(timeText);
	const dateMatch = normalizedDateText.match(/^(\d{1,2})\s+(.+?)\s+(\d{4})$/i);
	if (!dateMatch?.[1] || !dateMatch[2] || !dateMatch[3]) {
		throw new Error(`Invalid French date text: ${dateText} ${timeText}`);
	}

	const day = Number.parseInt(dateMatch[1], 10);
	const month = frenchMonthToIndex(dateMatch[2]);
	const year = Number.parseInt(dateMatch[3], 10);
	const timeMatch = normalizedTimeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (
		Number.isNaN(day) ||
		month === null ||
		Number.isNaN(year) ||
		!timeMatch?.[1] ||
		!timeMatch[2]
	) {
		throw new Error(`Invalid French date text: ${dateText} ${timeText}`);
	}

	const hours = Number.parseInt(timeMatch[1], 10);
	const minutes = Number.parseInt(timeMatch[2], 10);
	const seconds = timeMatch[3] ? Number.parseInt(timeMatch[3], 10) : 0;
	const date = new Date(year, month, day, hours, minutes, seconds, 0);

	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month ||
		date.getDate() !== day ||
		date.getHours() !== hours ||
		date.getMinutes() !== minutes ||
		date.getSeconds() !== seconds
	) {
		throw new Error(`Invalid French date text: ${dateText} ${timeText}`);
	}

	return date;
}

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
 * Parse le bloc HTML de détail d'un événement de planning et valide sa structure.
 *
 * @param body Réponse JSF contenant la modale de détail de l'événement.
 * @param eventId Identifiant de l'événement planning à rattacher au résultat.
 * @returns Les détails complets de l'événement de planning convertis en structure normalisée.
 * @throws {AurionError} Si le bloc de détail est absent, invalide ou incomplet.
 */
export function parseEventDetails(body: string, eventId: string): AurionPlanningEventDetails {
	const updateMatch = body.match(
		/<update id="form:modaleDetail"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
	);
	if (!updateMatch?.[1]) {
		throwParsingError(body, "parseEventDetails", "Modale detail update block not found");
	}

	const html = updateMatch[1];
	const tabsNavIndex = html.search(/<ul[^>]*class="[^"]*\bui-tabs-nav\b[^"]*"[^>]*>/i);
	const fieldsHtml = tabsNavIndex === -1 ? html : html.slice(0, tabsNavIndex);

	// Extract basic info
	const extractField = (label: string): string | null => {
		const labelPattern = escapeRegExp(label);
		const divMatch = fieldsHtml.match(
			new RegExp(
				`<div[^>]*class="ui-grid-row"[\\s\\S]*?<label[^>]*>[\\s\\S]*?(?:<span[^>]*>)?${labelPattern}(?:</span>)?[\\s\\S]*?</label>[\\s\\S]*?<div[^>]*class="ui-panelgrid-cell ui-grid-col-6">([\\s\\S]*?)</div>`,
				"i",
			),
		);
		if (divMatch?.[1]) {
			const value = normalizeWhitespace(stripTags(divMatch[1]));
			return value || null;
		}

		const tdMatch = fieldsHtml.match(
			new RegExp(
				`<tr[^>]*role="row"[\\s\\S]*?<label[^>]*>[\\s\\S]*?(?:<span[^>]*>)?${labelPattern}(?:</span>)?[\\s\\S]*?</label>[\\s\\S]*?</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
				"i",
			),
		);
		if (tdMatch?.[1]) {
			const value = normalizeWhitespace(stripTags(tdMatch[1]));
			return value || null;
		}
		return null;
	};

	const extractDateField = (label: string): Date | null => {
		const labelPattern = escapeRegExp(label);
		const rows = extractElementBlocks(fieldsHtml, "tr");
		for (const row of rows) {
			if (!new RegExp(`(?:<span[^>]*>)?${labelPattern}(?:</span>)?`, "i").test(row)) {
				continue;
			}

			const cells = extractElementBlocks(row, "td").map((cell) =>
				normalizeWhitespace(stripTags(cell)),
			);
			if (cells.length < 4 || !cells[1] || !cells[3]) {
				continue;
			}

			return parseFrenchDateText(cells[1], cells[3]);
		}

		return null;
	};

	const status = extractField("Statut");
	const subject = extractField("Matière");
	const teachingType = extractField("Type d'enseignement");
	const description = extractField("Description");
	const isExamStr = extractField("Est une épreuve");
	const isExam = isExamStr?.toLowerCase() === "oui";

	// Extract dates
	const start = extractDateField("Du");
	const end = extractDateField("Au");

	if (!start || !end) {
		throwParsingError(body, "parseEventDetails", "Planning detail dates not found", {
			startFound: Boolean(start),
			endFound: Boolean(end),
		});
	}

	// Extract datatables
	const extractTableData = (tabLabel: string, columns: string[]): Record<string, string>[] => {
		const panelId = extractTabPanelId(html, tabLabel);
		if (!panelId) {
			return [];
		}

		const panelHtml = extractElementBlockById(html, "div", panelId);
		if (!panelHtml) {
			return [];
		}

		const tableMatch = panelHtml.match(/<table\b[^>]*>[\s\S]*?<\/table>/i);
		if (!tableMatch) return [];

		const table = tableMatch[0];
		const theadMatch = table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
		if (!theadMatch || !theadMatch[1]) return [];

		const headers = extractElementBlocks(theadMatch[1], "th").map((th) =>
			normalizeWhitespace(stripTags(th)),
		);
		const normalizedHeaders = headers.map((header) => normalizeHeaderText(header));
		const normalizedColumns = columns.map((column) => normalizeHeaderText(column));

		// Check if this table has the expected columns
		const hasAllColumns = normalizedColumns.every((col) =>
			normalizedHeaders.some((h) => h.includes(col)),
		);
		if (hasAllColumns) {
			const tbodyMatch = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
			if (!tbodyMatch || !tbodyMatch[1]) return [];

			const rows = extractElementBlocks(tbodyMatch[1], "tr");
			const result = [];

			for (const row of rows) {
				const cells = extractElementBlocks(row, "td").map((td) =>
					normalizeWhitespace(stripTags(td)),
				);
				if (
					cells.length >= columns.length &&
					cells[0] &&
					!cells[0].includes("Aucun enregistrement")
				) {
					const rowData: Record<string, string> = {};
					columns.forEach((col) => {
						const normalizedColumn = normalizeHeaderText(col);
						const headerIndex = normalizedHeaders.findIndex((h) => h.includes(normalizedColumn));
						if (headerIndex !== -1 && cells[headerIndex]) {
							rowData[col] = cells[headerIndex];
						}
					});
					result.push(rowData);
				}
			}
			return result;
		}
		return [];
	};

	const teachersData = extractTableData("Intervenants", ["Nom", "Prenom"]);
	const studentsData = extractTableData("Apprenants", ["Nom", "Prenom"]);
	const groupsData = extractTableData("Groupes", ["Code", "Libelle"]);
	const coursesData = extractTableData("Cours", ["Code", "Cours", "Module"]);
	const resourcesData = extractTableData("Ressources", ["Code", "Libelle"]);

	return {
		eventId,
		start,
		end,
		status,
		subject,
		teachingType,
		description,
		isExam,
		teachers: teachersData.map((t) => ({
			lastName: t["Nom"] ?? "",
			firstName: t["Prenom"] ?? "",
		})),
		students: studentsData.map((s) => ({
			lastName: s["Nom"] ?? "",
			firstName: s["Prenom"] ?? "",
		})),
		groups: groupsData.map((g) => ({ code: g["Code"] ?? "", name: g["Libelle"] ?? "" })),
		courses: coursesData.map((c) => ({
			code: c["Code"] ?? "",
			course: c["Cours"] ?? "",
			module: c["Module"] ?? "",
		})),
		resources: resourcesData.map((r) => ({ code: r["Code"] ?? "", name: r["Libelle"] ?? "" })),
	};
}

/**
 * Parse la charge JSON d'événements du planning et valide sa structure.
 *
 * @param body Réponse JSF contenant le payload JSON du planning.
 * @returns Les événements de planning convertis en structures normalisées.
 * @throws {AurionError} Si le payload JSON est absent, invalide ou contient des événements mal formés.
 */
export function parsePlanningEvents(body: string): Array<Omit<AurionPlanningEvent, "getDetails">> {
	const payloadMatch =
		body.match(/(\[\{"id"[\s\S]*?}])/) ?? body.match(/\{\s*"events"\s*:\s*(\[[\s\S]*?])\s*}/);
	if (!payloadMatch?.[1]) {
		throwParsingError(body, "parsePlanningEvents", "Planning JSON payload not found");
	}

	const payload = payloadMatch[1];
	let parsed: unknown;

	try {
		parsed = JSON.parse(payload);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown JSON parsing error";
		throwParsingError(body, "parsePlanningEvents", `Invalid planning JSON payload: ${reason}`, {
			payloadSnippet: payload.slice(0, 280),
		});
	}

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
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.id === "string" &&
		typeof candidate.title === "string" &&
		"start" in candidate &&
		"end" in candidate &&
		typeof candidate.allDay === "boolean" &&
		typeof candidate.editable === "boolean" &&
		typeof candidate.className === "string"
	);
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
