/**
 * Codes d'erreur normalisés produits par le SDK Aurion.
 *
 * Ils permettent de distinguer de façon fiable les échecs d'authentification,
 * de navigation, de parsing ou de transport réseau.
 */
export type AurionErrorCode =
	| "AURION_AUTHENTICATION_ERROR"
	| "AURION_NAVIGATION_ERROR"
	| "AURION_PARSING_ERROR"
	| "AURION_TRANSPORT_ERROR"
	| "AURION_UNKNOWN_ERROR"
	| "AURION_NOT_IMPLEMENTED";

/**
 * Forme sérialisable des erreurs métier exposées au consommateur.
 *
 * Cette structure est renvoyée ou relancée par le SDK lorsqu'une erreur connue
 * survient pendant le dialogue avec Aurion.
 */
export interface AurionError {
	/** Nom stable de l'erreur, utile pour les gardes de type et les logs. */
	name: "AurionError";
	/** Message lisible décrivant la cause métier de l'échec. */
	message: string;
	/** Code d'erreur catégorisant précisément le type de problème rencontré. */
	code: AurionErrorCode;
	/** Charge utile optionnelle contenant du contexte technique supplémentaire. */
	details?: unknown;
}

/**
 * Vérifie qu'une valeur inconnue respecte la structure {@link AurionError}.
 *
 * Utile pour retraiter proprement une erreur capturée sans supposer son type.
 *
 * @param error Valeur arbitraire à tester.
 * @returns `true` si la valeur respecte la forme d'une {@link AurionError}.
 */
export function isAurionError(error: unknown): error is AurionError {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const candidate = error as Partial<AurionError>;

	return (
		candidate.name === "AurionError" &&
		typeof candidate.message === "string" &&
		typeof candidate.code === "string"
	);
}

/**
 * Construit une erreur Aurion homogène avec code, message et détails.
 *
 * @param code Code d'erreur normalisé à exposer.
 * @param message Message lisible décrivant la cause métier.
 * @param details Charge utile optionnelle avec du contexte technique.
 * @returns Une structure d'erreur compatible avec le SDK.
 */
export function createAurionError(
	code: AurionErrorCode,
	message: string,
	details?: unknown,
): AurionError {
	return {
		name: "AurionError",
		message,
		code,
		details,
	};
}
