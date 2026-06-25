import type { AurionCacheOptions, AurionCacheStore } from "./cache";

export type { AurionCacheEntry, AurionCacheStore, AurionTransportCacheEntry } from "./cache";
export type { AurionValueCacheEntry } from "./cache";
export type {
	AurionCacheOptions,
	AurionCacheTimeRangeApproximationOptions,
	AurionTimeRangeApproximation,
	AurionTimeRangeApproximationUnit,
} from "./cache";

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
	 * Configure le cache utilisé par la session et par la couche HTTP.
	 *
	 * - `true` active le cache mémoire fourni par le SDK.
	 * - `false` désactive totalement le cache.
	 * - Une implémentation {@link AurionCacheStore} permet d'injecter un backend
	 *   personnalisé avec `get`, `set`, `delete` et `clear`.
	 * - Un objet {@link AurionCacheOptions} permet de configurer le store et les
	 *   TTL d'invalidation des entrées de session et de transport.
	 *
	 * Les données de notes, planning et absences, ainsi que les réponses HTTP
	 * nécessaires à la navigation Aurion, peuvent alors être réutilisées au lieu
	 * d'être recalculées ou rechargées. Quand un TTL est défini, une entrée
	 * expirée est supprimée lors de sa lecture puis recalculée. `maxAgeMs`
	 * applique un TTL commun par défaut, et `sessionMaxAgeMs` /
	 * `transportMaxAgeMs` permettent de surcharger chaque couche.
	 * @default false
	 */
	cache?: boolean | AurionCacheStore | AurionCacheOptions;
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
	/** Type de l'événement (ex. "Cours", "TP", "Examen") tel que fourni par Aurion. */
	type: string;
	/** Charge les détails complets de l'événement depuis la modale Aurion. */
	getDetails(): Promise<AurionPlanningEventDetails>;
}

/**
 * Détails complets d'un événement de planning tels qu'affichés dans la modale Aurion.
 */
export interface AurionPlanningEventDetails {
	/** Identifiant de l'événement détaillé. */
	eventId: string;
	/** Date/heure de début affichée dans la modale. */
	start: Date;
	/** Date/heure de fin affichée dans la modale. */
	end: Date;
	/** Statut Aurion de l'événement, ou `null` si absent. */
	status: string | null;
	/** Matière ou catégorie pédagogique, ou `null` si absente. */
	subject: string | null;
	/** Type d'enseignement, ou `null` si absent. */
	teachingType: string | null;
	/** Description libre, ou `null` si vide. */
	description: string | null;
	/** Indique si l'événement est déclaré comme épreuve. */
	isExam: boolean;
	/** Intervenants associés à l'événement. */
	teachers: Array<{ lastName: string; firstName: string }>;
	/** Apprenants associés à l'événement. */
	students: Array<{ lastName: string; firstName: string }>;
	/** Groupes associés à l'événement. */
	groups: Array<{ code: string; name: string }>;
	/** Cours associés à l'événement. */
	courses: Array<{ code: string; course: string; module: string }>;
	/** Ressources ou salles associées à l'événement. */
	resources: Array<{ code: string; name: string }>;
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
	/** Libellé de la classe/cours concerné par l'absence. */
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
