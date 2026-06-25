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

/** Nœud racine ou intermédiaire du menu « Plannings Groupés par Promotion ». */
export class AurionPlanningGroup {
	public readonly name: string;
	public readonly id: string;
	public readonly session: AurionPlanningNavigator;

	constructor(name: string, id: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.session = session;
	}

	async getSubgroups(): Promise<AurionPlanningSubgroup[]> {
		return this.session.getSubgroups(this.id);
	}
}

/** Nœud terminal contenant une liste de plannings sélectionnables. */
export class AurionPlanningSubgroup {
	public readonly name: string;
	public readonly menuId: string;
	public readonly session: AurionPlanningNavigator;

	constructor(name: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.menuId = menuId;
		this.session = session;
	}

	async getPlannings(): Promise<AurionAvailablePlanning[]> {
		return this.session.getAvailablePlannings(this.menuId);
	}
}

/** Planning sélectionnable dans un sous-groupe de promotion. */
export class AurionAvailablePlanning {
	public readonly name: string;
	public readonly id: string;
	public readonly menuId: string;
	public readonly session: AurionPlanningNavigator;

	constructor(name: string, id: string, menuId: string, session: AurionPlanningNavigator) {
		this.name = name;
		this.id = id;
		this.menuId = menuId;
		this.session = session;
	}

	async getPlanning(options?: AurionPlanningOptions): Promise<AurionPlanningEvent[]> {
		return this.session.getPlanningForGroup(this.menuId, this.id, options);
	}
}
