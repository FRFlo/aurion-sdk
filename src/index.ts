/** Types d'erreur exposés par le SDK. */
export type { AurionError, AurionErrorCode } from "./errors";
/** Garde de type pour reconnaître une erreur Aurion structurée. */
export { isAurionError } from "./errors";
/** Client de session haut niveau pour l'accès aux notes Aurion. */
export { AurionSession } from "./session";
/** Types de données publics du SDK. */
export type {
	AurionAbsence,
	AurionGrade,
	AurionPlanningEvent,
	AurionPlanningOptions,
	AurionSessionOptions,
} from "./types";
export { parseAbsences, toAurionAbsence } from "./parsers/absences";
export { parseFormId, parseFormIdGrade, parseGrades, toAurionGrade } from "./parsers/grades";
export {
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
	isPlanningEvent,
} from "./parsers/planning";
export { parseAurionPlanningTitle, parseLocationToAddress, type Address } from "./utils";
export {
	parseIdInit,
	parseMenuId,
	parseViewState,
	normalizeText,
	decodeHtmlEntities,
	throwParsingError,
} from "./parsers/shared";
export type { ParsingErrorDetails } from "./parsers/shared";
export type { ParsedAurionPlanningTitle } from "./utils";
