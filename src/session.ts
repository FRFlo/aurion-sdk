import { createAurionError, isAurionError } from "./errors";
import {
	parseAbsences,
	toAurionAbsence,
} from "./parsers/absences";
import {
	parseFormId,
	parseFormIdGrade,
	parseGrades,
	toAurionGrade,
} from "./parsers/grades";
import {
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
} from "./parsers/planning";
import { parseIdInit, parseMenuId, parseViewState } from "./parsers/shared";
import { AurionTransport } from "./transport";
import type {
	AurionAbsence,
	AurionGrade,
	AurionPlanningEvent,
	AurionPlanningOptions,
	AurionSessionOptions,
	RawAurionAbsenceRow,
	RawAurionGradeRow,
} from "./types";

const DEFAULT_AURION_BASE_URL = "https://aurion.junia.com";
const MAIN_MENU_SUBMENU_ID = "submenu_44413";
const AURION_USER_CONTEXT_ID = "44323";
const FORM_URLENCODED_HEADERS = {
	"Content-Type": "application/x-www-form-urlencoded",
} as const;

/**
 * Session Aurion de haut niveau, responsable du flux d'authentification
 * puis de navigation jusqu'au tableau des notes.
 *
 * C'est le point d'entrée principal du SDK pour ouvrir une session
 * puis récupérer les notes de l'utilisateur authentifié.
 */
export class AurionSession {
	/** Identifiant Aurion utilisé pour ouvrir la session distante. */
	readonly username: string;
	/** Mot de passe transmis à Aurion lors de l'authentification. */
	readonly password: string;
	/** Indique si le cache interne des réponses HTTP est activé pour cette session. */
	readonly cache: boolean;
	/** URL de base de l'instance Aurion ciblée par la session. */
	readonly baseUrl: string;
	private readonly transport: AurionTransport;

	/**
	 * Initialise une session cliente à partir des options fournies.
	 *
	 * Les appels réseau ne sont pas déclenchés au constructeur ; l'authentification
	 * réelle a lieu lors du premier appel à {@link getGrades}.
	 */
	constructor(options: AurionSessionOptions) {
		this.username = options.username;
		this.password = options.password;
		this.cache = options.cache ?? false;
		this.baseUrl = options.baseUrl ?? DEFAULT_AURION_BASE_URL;
		this.transport = new AurionTransport({
			username: this.username,
			password: this.password,
			cache: this.cache,
			baseUrl: this.baseUrl,
			fetchFn: options.fetchFn,
		});
	}

	/**
	 * Récupère les notes Aurion puis les convertit en structure typée.
	 *
	 * La méthode gère automatiquement l'authentification, la navigation interne
	 * dans l'interface Aurion et la normalisation des valeurs retournées.
	 *
	 * @returns La liste des notes normalisées disponibles pour le compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou le parsing échoue.
	 */
	async getGrades(): Promise<AurionGrade[]> {
		try {
			await this.transport.login();

			const state: GradesNavigationState = {
				viewState: "",
				formId: "",
				menuId: "",
				idInit: "",
				formIdGrade: "",
			};

			await this.initializeSession(state);
			await this.postMainMenu(state);
			await this.postMainSidebar(state);

			const rawGrades = await this.postGrade(state);

			return rawGrades.map((rawGrade) => toAurionGrade(rawGrade));
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des notes Aurion.",
				error,
			);
		}
	}

	async getPlanning(options?: AurionPlanningOptions): Promise<AurionPlanningEvent[]> {
		try {
			await this.transport.login();

			const state: PlanningNavigationState = {
				viewState: "",
				menuId: "",
				idInit: "",
				formIdPlanning: "",
			};

			await this.initializeRootNavigationState(state, {
				includeFormId: false,
			});

			await this.loadPlanningSidebarMenuId(state);
			await this.postSidebarNavigation(state, "getPlanning:postMainSidebar");
			await this.loadPlanningFormState(state);

			const { startTimestamp, endTimestamp } = resolvePlanningWindow(options);
			const planningDate = new Date(startTimestamp);
			const today = planningDate.toLocaleDateString("fr-FR", {
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
			});
			const week = String(getWeekNumber(planningDate)).padStart(2, "0");
			const year = String(planningDate.getFullYear());

			const response = await this.postPlanning(state, startTimestamp, endTimestamp, today, week, year);

			return parsePlanningEvents(response.body);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération du planning Aurion.",
				error,
			);
		}
	}

	async getAbsences(): Promise<AurionAbsence[]> {
		try {
			await this.transport.login();

			const state: AbsencesNavigationState = {
				viewState: "",
				formId: "",
				menuId: "",
				idInit: "",
			};

			await this.initializeRootNavigationState(state, {
				includeFormId: true,
			});

			await this.postAbsencesMainMenu(state);
			await this.postSidebarNavigation(state, "getAbsences:postMainSidebar");
			await this.loadAbsencesPageState(state);

			const rawAbsences = await this.postAbsencesTable(state);

			return rawAbsences.map((rawAbsence) => toAurionAbsence(rawAbsence));
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des absences Aurion.",
				error,
			);
		}
	}

	/** Charge la page initiale et extrait les identifiants de session JSF. */
	private async initializeSession(state: GradesNavigationState): Promise<void> {
		await this.initializeRootNavigationState(state, {
			includeFormId: true,
		});
	}

	/** Ouvre le sous-menu principal qui mène à la zone des notes. */
	private async postMainMenu(state: GradesNavigationState): Promise<void> {
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": state.formId,
			"javax.faces.partial.execute": state.formId,
			"javax.faces.partial.render": "form:sidebar",
			[state.formId]: state.formId,
			"webscolaapp.Sidebar.ID_SUBMENU": MAIN_MENU_SUBMENU_ID,
			...createMainMenuCommonFields(state.idInit),
			...createFormFocusAndInputFields("form:j_idt773_focus", "form:j_idt773_input"),
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("postMainMenu", response.status, response.url);
		state.menuId = parseMenuId(response.body);
	}

	/** Navigue vers ChoixIndividu et prépare l'identifiant de table des notes. */
	private async postMainSidebar(state: GradesNavigationState): Promise<void> {
		await this.postSidebarNavigation(state, "postMainSidebar:submit");

		const getResponse = await this.transport.request({
			path: "/faces/ChoixIndividu.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/ChoixIndividu.xhtml`,
			},
			cache: false,
		});

		assertNavigationSuccess(
			"postMainSidebar:loadChoixIndividu",
			getResponse.status,
			getResponse.url,
		);

		state.viewState = parseViewState(getResponse.body);
		state.formIdGrade = parseFormIdGrade(getResponse.body);
	}

	private async loadPlanningSidebarMenuId(state: PlanningNavigationState): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/`,
			},
			cache: false,
		});

		assertNavigationSuccess("getPlanning:loadMainMenu", response.status, response.url);
		state.menuId = parseSidebarMenuIdForMonPlanning(response.body);
	}

	private async loadPlanningFormState(state: PlanningNavigationState): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/MainMenuPage.xhtml`,
			},
			cache: false,
		});

		assertNavigationSuccess("getPlanning:loadPlanningPage", response.status, response.url);
		state.viewState = parseViewState(response.body);
		state.formIdPlanning = parseFormIdPlanning(response.body);
	}

	private async postPlanning(
		state: PlanningNavigationState,
		startTimestamp: number,
		endTimestamp: number,
		today: string,
		week: string,
		year: string,
	): Promise<{ body: string }> {
		const sourceId = state.formIdPlanning;
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": sourceId,
			"javax.faces.partial.execute": sourceId,
			"javax.faces.partial.render": sourceId,
			[sourceId]: sourceId,
			[`${sourceId}_start`]: String(startTimestamp),
			[`${sourceId}_end`]: String(endTimestamp),
			...createMainMenuCommonFields(state.idInit, ""),
			"form:date_input": today,
			"form:week": `${week}-${year}`,
			[`${sourceId}_view`]: "agendaWeek",
			"form:offsetFuseauNavigateur": "-7200000",
			"form:onglets_activeIndex": "0",
			"form:onglets_scrollState": "0",
			...createFormFocusAndInputFields("form:j_idt244_focus", "form:j_idt244_input"),
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("getPlanning:postPlanning", response.status, response.url);

		return {
			body: response.body,
		};
	}

	private async postAbsencesMainMenu(state: AbsencesNavigationState): Promise<void> {
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": state.formId,
			"javax.faces.partial.execute": state.formId,
			"javax.faces.partial.render": "form:sidebar",
			[state.formId]: state.formId,
			"webscolaapp.Sidebar.ID_SUBMENU": MAIN_MENU_SUBMENU_ID,
			...createMainMenuCommonFields(state.idInit),
			...createFormFocusAndInputFields("form:j_idt773_focus", "form:j_idt773_input"),
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("getAbsences:postMainMenu", response.status, response.url);
		state.menuId = parseMenuId(response.body, "Mes absences</span>");
	}

	private async loadAbsencesPageState(state: AbsencesNavigationState): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/MesAbsences.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/MesAbsences.xhtml`,
			},
			cache: false,
		});

		assertNavigationSuccess("getAbsences:loadMesAbsences", response.status, response.url);

		state.viewState = parseViewState(response.body);
		state.idInit = parseIdInit(response.body);
	}

	private async postAbsencesTable(state: AbsencesNavigationState): Promise<RawAurionAbsenceRow[]> {
		const sourceId = "form:table";
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": sourceId,
			"javax.faces.partial.execute": sourceId,
			"javax.faces.partial.render": sourceId,
			[sourceId]: sourceId,
			[`${sourceId}_pagination`]: "true",
			[`${sourceId}_first`]: "0",
			[`${sourceId}_rows`]: "20000",
			[`${sourceId}_skipChildren`]: "true",
			[`${sourceId}_encodeFeature`]: "true",
			...createMainMenuCommonFields(state.idInit),
			"form:search-texte": "",
			"form:search-texte-avancer": "",
			"form:input-expression-exacte": "",
			"form:input-un-des-mots": "",
			"form:input-aucun-des-mots": "",
			"form:input-nombre-debut": "",
			"form:input-nombre-fin": "",
			"form:calendarDebut_input": "",
			"form:calendarFin_input": "",
			[`${sourceId}_reflowDD`]: "0_0",
			[`${sourceId}_selection`]: "",
			...createFormFocusAndInputFields("form:j_idt191_focus", "form:j_idt191_input"),
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MesAbsences.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("getAbsences:postAbsences", response.status, response.url);

		return parseAbsences(response.body);
	}

	/** Déclenche la requête PrimeFaces qui renvoie les lignes de notes. */
	private async postGrade(state: GradesNavigationState): Promise<RawAurionGradeRow[]> {
		const tableId = state.formIdGrade;
		const sourceId = `form:${tableId}`;
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": sourceId,
			"javax.faces.partial.execute": sourceId,
			"javax.faces.partial.render": sourceId,
			[sourceId]: sourceId,
			[`${sourceId}_pagination`]: "true",
			[`${sourceId}_first`]: "0",
			[`${sourceId}_rows`]: "20000",
			[`${sourceId}_skipChildren`]: "true",
			[`${sourceId}_encodeFeature`]: "true",
			...createMainMenuCommonFields(state.idInit, "1620"),
			"form:messagesRubriqueInaccessible": "",
			"form:search-texte": "",
			"form:search-texte-avancer": "",
			"form:input-expression-exacte": "",
			"form:input-un-des-mots": "",
			"form:input-aucun-des-mots": "",
			"form:input-nombre-debut": "",
			"form:input-nombre-fin": "",
			"form:calendarDebut_input": "",
			"form:calendarFin_input": "",
			[`${sourceId}_reflowDD`]: "0_0",
			[`${sourceId}:j_idt273:filter`]: "",
			[`${sourceId}:j_idt275:filter`]: "",
			[`${sourceId}:j_idt277:filter`]: "",
			[`${sourceId}:j_idt279:filter`]: "",
			[`${sourceId}:j_idt281:filter`]: "",
			[`${sourceId}:j_idt283:filter`]: "",
			...createFormFocusAndInputFields("form:j_idt258_focus", "form:j_idt258_input"),
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/ChoixIndividu.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("postGrade", response.status, response.url);

		return parseGrades(response.body);
	}

	private async initializeRootNavigationState(
		state: { viewState: string; idInit: string; formId?: string },
		options: { includeFormId: boolean },
	): Promise<void> {
		const response = await this.transport.request({
			path: "/",
			method: "GET",
			cache: false,
		});

		assertNavigationSuccess("initializeSession", response.status, response.url);

		state.viewState = parseViewState(response.body);
		state.idInit = parseIdInit(response.body);

		if (options.includeFormId) {
			state.formId = parseFormId(response.body);
		}
	}

	private async postSidebarNavigation(
		state: { viewState: string; idInit: string; menuId: string },
		step: string,
	): Promise<void> {
		const postData = new URLSearchParams({
			...createMainMenuCommonFields(state.idInit),
			...createFormFocusAndInputFields("form:j_idt773_focus", "form:j_idt773_input"),
			"javax.faces.ViewState": state.viewState,
			"form:sidebar": "form:sidebar",
			"form:sidebar_menuid": state.menuId,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess(step, response.status, response.url);
	}
}

/** État intermédiaire propagé entre les étapes de navigation Aurion. */
interface GradesNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
	formIdGrade: string;
}

interface PlanningNavigationState {
	viewState: string;
	menuId: string;
	idInit: string;
	formIdPlanning: string;
}

interface AbsencesNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
}

/** Valide qu'une étape HTTP de navigation Aurion a réussi. */
function assertNavigationSuccess(step: string, status: number, url: string): void {
	if (status >= 200 && status < 300) {
		return;
	}

	throw createAurionError(
		"AURION_NAVIGATION_ERROR",
		`Navigation Aurion échouée à l'étape ${step}.`,
		{
			step,
			status,
			url,
			expected: "2xx",
		},
	);
}

function createMainMenuCommonFields(idInit: string, largeurDivCenter = "885"): Record<string, string> {
	return {
		form: "form",
		"form:largeurDivCenter": largeurDivCenter,
		"form:idInit": idInit,
		"form:sauvegarde": "",
	};
}

function createFormFocusAndInputFields(focusField: string, inputField: string): Record<string, string> {
	return {
		[focusField]: "",
		[inputField]: AURION_USER_CONTEXT_ID,
	};
}

function resolvePlanningWindow(options?: AurionPlanningOptions): {
	startTimestamp: number;
	endTimestamp: number;
} {
	const startTimestamp = options?.startTimestamp ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
	const endTimestamp = options?.endTimestamp ?? startTimestamp + 60 * 24 * 60 * 60 * 1000;

	return {
		startTimestamp,
		endTimestamp,
	};
}

function getWeekNumber(date: Date): number {
	const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
	const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;

	return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}
