import { createAurionError, isAurionError } from "./errors";
import {
	parseFormId,
	parseFormIdGrade,
	parseGrades,
	parseIdInit,
	parseMenuId,
	parseViewState,
	toAurionGrade,
} from "./grades-parser";
import { AurionTransport } from "./transport";
import type { AurionGrade, AurionSessionOptions, RawAurionGradeRow } from "./types";

const DEFAULT_AURION_BASE_URL = "https://aurion.junia.com";

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

	/** Charge la page initiale et extrait les identifiants de session JSF. */
	private async initializeSession(state: GradesNavigationState): Promise<void> {
		const response = await this.transport.request({
			path: "/",
			method: "GET",
			cache: false,
		});

		assertNavigationSuccess("initializeSession", response.status, response.url);

		state.viewState = parseViewState(response.body);
		state.formId = parseFormId(response.body);
		state.idInit = parseIdInit(response.body);
	}

	/** Ouvre le sous-menu principal qui mène à la zone des notes. */
	private async postMainMenu(state: GradesNavigationState): Promise<void> {
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": state.formId,
			"javax.faces.partial.execute": state.formId,
			"javax.faces.partial.render": "form:sidebar",
			[state.formId]: state.formId,
			"webscolaapp.Sidebar.ID_SUBMENU": "submenu_44413",
			form: "form",
			"form:largeurDivCenter": "885",
			"form:idInit": state.idInit,
			"form:sauvegarde": "",
			"form:j_idt773_focus": "",
			"form:j_idt773_input": "44323",
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			cache: false,
		});

		assertNavigationSuccess("postMainMenu", response.status, response.url);
		state.menuId = parseMenuId(response.body);
	}

	/** Navigue vers ChoixIndividu et prépare l'identifiant de table des notes. */
	private async postMainSidebar(state: GradesNavigationState): Promise<void> {
		const postData = new URLSearchParams({
			form: "form",
			"form:largeurDivCenter": "885",
			"form:idInit": state.idInit,
			"form:sauvegarde": "",
			"form:j_idt773_focus": "",
			"form:j_idt773_input": "44323",
			"javax.faces.ViewState": state.viewState,
			"form:sidebar": "form:sidebar",
			"form:sidebar_menuid": state.menuId,
		});

		const postResponse = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			cache: false,
		});

		assertNavigationSuccess("postMainSidebar:submit", postResponse.status, postResponse.url);

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
			form: "form",
			"form:largeurDivCenter": "1620",
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
			"form:j_idt258_focus": "",
			"form:j_idt258_input": "44323",
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/ChoixIndividu.xhtml",
			method: "POST",
			body: postData,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			cache: false,
		});

		assertNavigationSuccess("postGrade", response.status, response.url);

		return parseGrades(response.body);
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
