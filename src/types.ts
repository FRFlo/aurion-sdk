/**
 * Options de configuration pour créer une session Aurion.
 *
 * Cet objet regroupe les informations d'authentification et les options
 * réseau nécessaires pour initialiser {@link AurionSession}.
 */
export interface AurionSessionOptions {
	/**
	 * Identifiant de connexion Aurion utilisé lors de l'authentification.
	 * Il correspond généralement au login fourni par l'établissement.
	 */
	username: string;
	/**
	 * Mot de passe associé au compte Aurion.
	 * Cette valeur n'est utilisée que pour établir la session distante.
	 */
	password: string;
	/**
	 * Implémentation personnalisée de `fetch` à utiliser pour les requêtes HTTP.
	 * Permet d'injecter un mock, un wrapper instrumenté ou une implémentation
	 * adaptée à un runtime spécifique.
	 */
	fetchFn?: typeof fetch;
	/**
	 * Active le cache des requêtes pendant la session.
	 * Les réponses identiques peuvent alors être réutilisées au lieu de relancer
	 * une requête réseau vers Aurion.
	 * @default false
	 */
	cache?: boolean;
	/**
	 * URL de base de l'instance Aurion.
	 * À modifier uniquement si votre établissement expose Aurion sur un domaine
	 * différent de la valeur par défaut.
	 * @default "https://aurion.junia.com"
	 */
	baseUrl?: string;
}

/**
 * Ligne de note brute telle qu'extraite du HTML Aurion.
 *
 * Toutes les propriétés sont encore textuelles à ce stade.
 */
export interface RawAurionGradeRow {
	date: string;
	code: string;
	name: string;
	grade: string;
	coefficient: string;
	average: string;
	min: string;
	max: string;
	median: string;
	standardDeviation: string;
	comment: string;
}

/**
 * Note normalisée renvoyée par le SDK.
 *
 * Les champs numériques sont convertis en `number` quand cela est possible,
 * sinon à `null` lorsque l'information est absente ou non exploitable.
 */
export interface AurionGrade {
	/** Date de l'évaluation telle que restituée par Aurion. */
	date: string;
	/** Code matière ou identifiant court de l'évaluation. */
	code: string;
	/** Intitulé lisible de la note ou de l'épreuve. */
	name: string;
	/** Note obtenue par l'étudiant. `null` si la valeur est absente ou non numérique. */
	grade: number | null;
	/** Coefficient appliqué à la note. `null` si Aurion ne fournit pas de valeur exploitable. */
	coefficient: number | null;
	/** Moyenne du groupe ou de la classe. `null` si non disponible. */
	average: number | null;
	/** Plus petite note observée. `null` si non disponible. */
	min: number | null;
	/** Plus grande note observée. `null` si non disponible. */
	max: number | null;
	/** Médiane de distribution des notes. `null` si non disponible. */
	median: number | null;
	/** Écart-type de la distribution. `null` si non disponible. */
	standardDeviation: number | null;
	/** Commentaire pédagogique associé à la note, ou `null` s'il est vide. */
	comment: string | null;
}

export interface AurionPlanningOptions {
	startTimestamp?: number;
	endTimestamp?: number;
}

export interface AurionPlanningEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	editable: boolean;
	className: string;
}

export interface RawAurionAbsenceRow {
	date: string;
	type: string;
	duration: string;
	time: string;
	class: string;
	teacher: string;
}

export interface AurionAbsence {
	date: string;
	type: string;
	duration: string;
	time: string;
	class: string;
	teacher: string;
}
