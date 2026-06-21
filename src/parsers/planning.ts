import type { AurionPlanningEvent } from "../types";

import { parseDateOrThrow, throwParsingError } from "./shared";

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
export function parsePlanningEvents(body: string): AurionPlanningEvent[] {
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
		typeof candidate.type === "string"
	);
}
