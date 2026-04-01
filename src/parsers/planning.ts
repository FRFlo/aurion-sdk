import type { AurionPlanningEvent } from "../types";

import { parseDateOrThrow, throwParsingError } from "./shared";

/** Extrait l'identifiant du widget agenda PrimeFaces de la page Planning. */
export function parseFormIdPlanning(body: string): string {
	const match = body.match(/PrimeFaces\.cw\("Schedule","schedule",\{id:"([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseFormIdPlanning", "Planning schedule widget id not found");
	}

	return match[1];
}

/** Extrait l'identifiant de menu latéral correspondant à l'entrée « Mon Planning ». */
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

/** Parse la charge JSON d'événements du planning et valide sa structure. */
export function parsePlanningEvents(body: string): AurionPlanningEvent[] {
	const payloadMatch = body.match(/(\[\{"id"[\s\S]*?}])/);
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
			location: event.location,
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
	location: string;
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
		typeof candidate.location === "string"
	);
}

/** Vérifie qu'une valeur inconnue respecte la forme d'un événement planning Aurion. */
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
		typeof candidate.location === "string"
	);
}
