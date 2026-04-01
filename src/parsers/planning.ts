import type { AurionPlanningEvent } from "../types";

import { throwParsingError } from "./shared";

export function parseFormIdPlanning(body: string): string {
	const match = body.match(/PrimeFaces\.cw\("Schedule","schedule",\{id:"([^"]+)"/);
	if (!match?.[1]) {
		throwParsingError(body, "parseFormIdPlanning", "Planning schedule widget id not found");
	}

	return match[1];
}

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
		if (!isPlanningEvent(event)) {
			throwParsingError(body, "parsePlanningEvents", "Planning event has invalid shape", {
				index,
				event,
				payloadSnippet: payload.slice(0, 280),
			});
		}

		return {
			id: event.id,
			title: event.title,
			start: event.start,
			end: event.end,
			allDay: event.allDay,
			editable: event.editable,
			className: event.className,
		};
	});
}

export function isPlanningEvent(value: unknown): value is AurionPlanningEvent {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.id === "string" &&
		typeof candidate.title === "string" &&
		typeof candidate.start === "string" &&
		typeof candidate.end === "string" &&
		typeof candidate.allDay === "boolean" &&
		typeof candidate.editable === "boolean" &&
		typeof candidate.className === "string"
	);
}
