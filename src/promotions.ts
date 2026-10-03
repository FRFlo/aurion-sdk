import type { AurionPlanningEvent, AurionPlanningOptions, AurionRequestOptions } from "./types";

/** Opérations de session requises pour parcourir les plannings de promotion. */
export interface AurionPlanningNavigator {
	/**
	 * Récupère les sous-groupes disponibles dans le menu indiqué.
	 * @param submenuId Identifiant du sous-menu parent.
	 * @param options Options d'appel, dont le signal d'annulation éventuel.
	 * @returns Les sous-groupes accessibles depuis ce menu.
	 */
	getSubgroups(
		submenuId: string,
		options?: AurionRequestOptions,
	): Promise<AurionPlanningSubgroup[]>;
	/**
	 * Récupère les plannings sélectionnables d'un menu.
	 * @param menuId Identifiant du menu contenant le catalogue.
	 * @param options Options d'appel, dont le signal d'annulation éventuel.
	 * @returns Les plannings disponibles dans ce menu.
	 */
	getAvailablePlannings(
		menuId: string,
		options?: AurionRequestOptions,
	): Promise<AurionAvailablePlanning[]>;
	/**
	 * Charge les événements d'un planning de groupe, éventuellement filtrés par période.
	 * @param menuId Identifiant du menu parent du planning.
	 * @param planningId Identifiant du planning à charger.
	 * @param options Fenêtre temporelle et options d'annulation éventuelles.
	 * @returns Les événements de planning normalisés.
	 */
	getPlanningForGroup(
		menuId: string,
		planningId: string,
		options?: AurionPlanningOptions,
	): Promise<AurionPlanningEvent[]>;
}

/** Nœud racine ou intermédiaire du menu « Plannings Groupés par Promotion ». */
export class AurionPlanningGroup {
	/** Libellé affiché du nœud de menu. */
	public readonly name: string;
	/** Identifiant de menu transmis aux opérations de navigation. */
	public readonly id: string;
	/** Navigateur utilisé pour charger les éléments enfants. */
	public readonly session: AurionPlanningNavigator;

	/** Crée un nœud de menu de planning. */
	constructor(name: string, id: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.session = session;
	}

	/**
	 * Charge les sous-groupes de ce nœud.
	 * @param options Options d'appel, dont le signal d'annulation éventuel.
	 * @returns Les sous-groupes accessibles depuis ce groupe.
	 */
	async getSubgroups(options?: AurionRequestOptions): Promise<AurionPlanningSubgroup[]> {
		return this.session.getSubgroups(this.id, options);
	}
}

/** Nœud terminal contenant une liste de plannings sélectionnables. */
export class AurionPlanningSubgroup {
	/** Libellé affiché du sous-groupe. */
	public readonly name: string;
	/** Identifiant de menu utilisé pour obtenir les plannings. */
	public readonly menuId: string;
	/** Navigateur utilisé pour charger les plannings. */
	public readonly session: AurionPlanningNavigator;

	/** Crée un sous-groupe contenant des plannings sélectionnables. */
	constructor(name: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.menuId = menuId;
		this.session = session;
	}

	/**
	 * Charge les plannings disponibles dans ce sous-groupe.
	 * @param options Options d'appel, dont le signal d'annulation éventuel.
	 * @returns Les plannings sélectionnables du sous-groupe.
	 */
	async getPlannings(options?: AurionRequestOptions): Promise<AurionAvailablePlanning[]> {
		return this.session.getAvailablePlannings(this.menuId, options);
	}
}

/** Planning sélectionnable dans un sous-groupe de promotion. */
export class AurionAvailablePlanning {
	/** Libellé affiché du planning. */
	public readonly name: string;
	/** Identifiant du planning à transmettre au chargement. */
	public readonly id: string;
	/** Identifiant du menu parent requis pour le chargement. */
	public readonly menuId: string;
	/** Navigateur utilisé pour charger les événements. */
	public readonly session: AurionPlanningNavigator;

	/** Crée une référence vers un planning sélectionnable. */
	constructor(name: string, id: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.menuId = menuId;
		this.session = session;
	}

	/**
	 * Charge les événements de ce planning avec les filtres et options fournis.
	 * @param options Fenêtre temporelle et options d'annulation éventuelles.
	 * @returns Les événements correspondant à ce planning.
	 */
	async getPlanning(options?: AurionPlanningOptions): Promise<AurionPlanningEvent[]> {
		return this.session.getPlanningForGroup(this.menuId, this.id, options);
	}
}
