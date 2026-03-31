/** Types d'erreur exposés par le SDK. */
export type { AurionError, AurionErrorCode } from "./errors";
/** Garde de type pour reconnaître une erreur Aurion structurée. */
export { isAurionError } from "./errors";
/** Client de session haut niveau pour l'accès aux notes Aurion. */
export { AurionSession } from "./session";
/** Types de données publics du SDK. */
export type { AurionGrade, AurionSessionOptions } from "./types";
