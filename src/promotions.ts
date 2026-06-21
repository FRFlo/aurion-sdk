import type { AurionPlanningEvent, AurionPlanningOptions } from "./types";

export interface AurionPlanningNavigator {
	getSubgroups(submenuId: string): Promise<AurionPlanningSubgroup[]>;
	getAvailablePlannings(menuId: string): Promise<AurionAvailablePlanning[]>;
	getPlanningForGroup(
		menuId: string,
		planningId: string,
		options?: AurionPlanningOptions,
	): Promise<AurionPlanningEvent[]>;
}

/**
 * Groupe de plannings Aurion exposé par le menu « Plannings Groupés par Promotion ».
 *
 * Un groupe correspond à un nœud intermédiaire du menu latéral Aurion, par exemple
 * « Planning ISEN AP ». Il peut contenir d'autres groupes ou des sous-groupes terminaux.
 */
export class AurionPlanningGroup {
	/** Libellé affiché par Aurion pour ce groupe. */
	public readonly name: string;
	/** Identifiant PrimeFaces `submenu_XXXXX` permettant d'ouvrir ce groupe. */
	public readonly id: string;
	/** Session SDK utilisée pour poursuivre la navigation réseau depuis ce nœud. */
	public readonly session: AurionPlanningNavigator;

	/**
	 * Crée une représentation SDK d'un groupe de plannings.
	 *
	 * @param name Libellé affiché par Aurion.
	 * @param id Identifiant PrimeFaces du sous-menu.
	 * @param session Session capable de charger les enfants du groupe.
	 */
	constructor(name: string, id: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.session = session;
	}

	/**
	 * Charge les enfants directs du groupe depuis Aurion.
	 *
	 * @returns Les sous-groupes contenus dans ce groupe.
	 * @throws {AurionError} Si Aurion refuse la navigation ou si le menu retourné est inexploitable.
	 */
	async getSubgroups(): Promise<AurionPlanningSubgroup[]> {
		return this.session.getSubgroups(this.id);
	}
}

/**
 * Sous-groupe terminal de planning Aurion.
 *
 * Un sous-groupe correspond à une entrée finale du menu latéral, par exemple
 * « Planning ISEN AP3 ». Il ouvre la page `ChoixPlanning.xhtml` qui liste les
 * plannings disponibles pour cette promotion ou ce groupe pédagogique.
 */
export class AurionPlanningSubgroup {
	/** Libellé affiché par Aurion pour ce sous-groupe. */
	public readonly name: string;
	/** Identifiant `form:sidebar_menuid` utilisé pour ouvrir `ChoixPlanning.xhtml`. */
	public readonly menuId: string;
	/** Session SDK utilisée pour charger les plannings disponibles. */
	public readonly session: AurionPlanningNavigator;

	/**
	 * Crée une représentation SDK d'un sous-groupe de plannings.
	 *
	 * @param name Libellé affiché par Aurion.
	 * @param menuId Identifiant de menu latéral terminal.
	 * @param session Session capable de charger les plannings du sous-groupe.
	 */
	constructor(name: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.menuId = menuId;
		this.session = session;
	}

	/**
	 * Charge les plannings sélectionnables pour ce sous-groupe.
	 *
	 * @returns La liste des plannings proposés par Aurion dans `ChoixPlanning.xhtml`.
	 * @throws {AurionError} Si la page de choix ne peut pas être ouverte ou parsée.
	 */
	async getPlannings(): Promise<AurionAvailablePlanning[]> {
		return this.session.getAvailablePlannings(this.menuId);
	}
}

/**
 * Planning sélectionnable pour un sous-groupe Aurion.
 *
 * Cette classe représente une ligne de `ChoixPlanning.xhtml`. Son identifiant de
 * ligne PrimeFaces est réutilisé pour ouvrir la page calendrier correspondante,
 * puis récupérer les événements via le parseur de planning existant.
 */
export class AurionAvailablePlanning {
	/** Libellé complet de la ligne de planning affichée par Aurion. */
	public readonly name: string;
	/** Identifiant de ligne `data-rk` utilisé par la table PrimeFaces. */
	public readonly id: string;
	/** Identifiant du sous-groupe parent dans le menu latéral Aurion. */
	public readonly menuId: string;
	/** Session SDK utilisée pour ouvrir et lire ce planning. */
	public readonly session: AurionPlanningNavigator;

	/**
	 * Crée une représentation SDK d'un planning disponible.
	 *
	 * @param name Libellé complet du planning.
	 * @param id Identifiant PrimeFaces de la ligne sélectionnable.
	 * @param menuId Identifiant du sous-groupe parent.
	 * @param session Session capable de charger les événements du planning.
	 */
	constructor(name: string, id: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.menuId = menuId;
		this.session = session;
	}

	/**
	 * Récupère les événements du planning sélectionné.
	 *
	 * @param options Fenêtre temporelle optionnelle à demander à Aurion.
	 * @returns Les événements normalisés du calendrier.
	 * @throws {AurionError} Si la sélection du planning ou la requête calendrier échoue.
	 */
	async getPlanning(options?: AurionPlanningOptions): Promise<AurionPlanningEvent[]> {
		return this.session.getPlanningForGroup(this.menuId, this.id, options);
	}
}
