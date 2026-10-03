/** Types d'erreur exposés par le SDK. */
export type { AurionError, AurionErrorCode } from "./errors";
/** Garde de type pour reconnaître une erreur Aurion structurée. */
export { isAurionError } from "./errors";
/** Client de session haut niveau pour l'accès aux notes Aurion. */
export { AurionSession } from "./session";
/** Wrappers de navigation pour les groupes, sous-groupes et plannings Aurion. */
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
	AurionRequestOptions,
	AurionSessionOptions,
	AurionTimeRangeApproximation,
	AurionTimeRangeApproximationUnit,
} from "./types";
/** Parse et normalise les données de la rubrique des absences. */
export { parseAbsences, toAurionAbsence } from "./parsers/absences";
/** Parse et normalise les notes et les identifiants de leurs formulaires. */
export { parseFormId, parseFormIdGrade, parseGrades, toAurionGrade } from "./parsers/grades";
/** Parse les événements, détails et identifiants du planning Aurion. */
export {
	parseEventDetails,
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
	isPlanningEvent,
} from "./parsers/planning";
/** Parse les entrées de menu et les plannings groupés par promotion. */
export { parseSubmenuId, parseMenuChildren, parseAvailablePlannings } from "./parsers/promotions";
/** Utilitaires de conversion des titres, lieux et codes de notes. */
export {
	parseAurionPlanningTitle,
	parseLocationToAddress,
	type Address,
	type GradeDetails,
	parseGradeToDetails,
} from "./utils";
/** Utilitaires de parsing des éléments partagés des pages JSF Aurion. */
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
