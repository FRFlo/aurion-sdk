/** Parse et normalise les lignes de la page des absences. */
export { parseAbsences, toAurionAbsence } from "./absences";
/** Parse les notes et les identifiants des formulaires associés. */
export { parseFormId, parseFormIdGrade, parseGrades, toAurionGrade } from "./grades";
/** Parse les événements, les détails et les éléments du calendrier. */
export {
	parseEventDetails,
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
	isPlanningEvent,
} from "./planning";
/** Parse les entrées des menus et le catalogue des plannings. */
export { parseSubmenuId, parseMenuChildren, parseAvailablePlannings } from "./promotions";
/** Expose les utilitaires de parsing des pages et champs JSF communs. */
export {
	parseIdInit,
	parseMenuId,
	parseViewState,
	normalizeText,
	decodeHtmlEntities,
	throwParsingError,
} from "./shared";
/** Contexte diagnostique produit par les erreurs de parsing. */
export type { ParsingErrorDetails } from "./shared";
