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
	/** Date de l'évaluation convertie en objet natif JavaScript `Date`. */
	date: Date;
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

/**
 * Options de filtrage temporel pour récupérer le planning.
 *
 * Les bornes sont exprimées en objets JavaScript `Date`.
 */
export interface AurionPlanningOptions {
	/** Début de la fenêtre de recherche. */
	start?: Date;
	/** Fin de la fenêtre de recherche. */
	end?: Date;
}

/**
 * Événement de planning normalisé renvoyé par le SDK.
 *
 * Ce format reprend la structure utilisée par l'interface calendrier Aurion.
 */
export interface AurionPlanningEvent {
	/** Identifiant unique de l'événement dans le planning. */
	id: string;
	/** Intitulé affiché pour le cours, TP ou activité planifiée. */
	title: string;
	/** Date/heure de début de l'événement convertie en objet natif JavaScript `Date`. */
	start: Date;
	/** Date/heure de fin de l'événement convertie en objet natif JavaScript `Date`. */
	end: Date;
	/** Indique si l'événement couvre une journée entière sans horaire précis. */
	allDay: boolean;
	/** Indique si l'événement est modifiable depuis l'interface source. */
	editable: boolean;
	/** Classe CSS Aurion associée à l'événement (style, catégorie, statut visuel). */
	className: string;
}

/**
 * Ligne d'absence brute extraite de la table Aurion.
 *
 * Les valeurs sont conservées telles qu'elles apparaissent dans le HTML.
 */
export interface RawAurionAbsenceRow {
	/** Date d'absence telle qu'affichée dans Aurion. */
	date: string;
	/** Type d'absence (justifiée, non justifiée, retard, etc.). */
	type: string;
	/** Durée textuelle de l'absence (ex. "2h", "journée"). */
	duration: string;
	/** Créneau horaire concerné tel que fourni par Aurion. */
	time: string;
	/** Libellé de la classe/groupe concerné par l'absence. */
	class: string;
	/** Enseignant associé à l'absence, tel qu'indiqué dans Aurion. */
	teacher: string;
}

/**
 * Absence normalisée renvoyée par le SDK.
 *
 * Les champs temporels sont convertis en objets natifs JavaScript `Date`.
 */
export interface AurionAbsence {
	/** Date d'absence convertie en objet natif JavaScript `Date`. */
	date: Date;
	/** Type d'absence interprétable par l'utilisateur final. */
	type: string;
	/** Durée déclarée de l'absence. */
	duration: string;
	/** Horodatage de début de tranche converti en objet natif JavaScript `Date`. */
	time: Date;
	/** Classe/groupe concerné par l'absence. */
	class: string;
	/** Enseignant rattaché à l'enregistrement d'absence. */
	teacher: string;
}
