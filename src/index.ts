/** Types d'erreur exposés par le SDK. */
export type { AurionError, AurionErrorCode } from "./errors";
/** Garde de type pour reconnaître une erreur Aurion structurée. */
export { isAurionError } from "./errors";
/** Client de session haut niveau pour l'accès aux notes Aurion. */
export { AurionSession } from "./session";
export { AurionPlanningGroup, AurionPlanningSubgroup, AurionAvailablePlanning } from "./promotions";
/** Outils de cache publics du SDK. */
export {
	isAurionCacheEntryExpired,
	isAurionCacheStore,
	createAurionCacheKey,
	createAurionValueCacheKey,
	InMemoryAurionCache,
	isAurionTransportCacheEntry,
	isAurionValueCacheEntry,
	resolveAurionCacheConfig,
	resolveAurionCacheStore,
} from "./cache";
/** Types de données publics du SDK. */
export type {
	AurionAbsence,
	AurionCacheEntry,
	AurionCacheOptions,
	AurionCacheStore,
	AurionCacheTimeRangeApproximationOptions,
	AurionGrade,
	AurionPlanningEvent,
	AurionPlanningEventDetails,
	AurionPlanningOptions,
	AurionSessionOptions,
	AurionTimeRangeApproximation,
	AurionTimeRangeApproximationUnit,
} from "./types";
export { parseAbsences, toAurionAbsence } from "./parsers/absences";
export { parseFormId, parseFormIdGrade, parseGrades, toAurionGrade } from "./parsers/grades";
export {
	parseEventDetails,
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
	isPlanningEvent,
} from "./parsers/planning";
export { parseSubmenuId, parseMenuChildren, parseAvailablePlannings } from "./parsers/promotions";
export {
	parseAurionPlanningTitle,
	parseLocationToAddress,
	type Address,
	type GradeDetails,
	parseGradeToDetails,
} from "./utils";
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
