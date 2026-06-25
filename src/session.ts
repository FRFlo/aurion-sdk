import {
	createAurionValueCacheKey,
	isAurionCacheEntryExpired,
	isAurionValueCacheEntry,
	resolveAurionCacheConfig,
} from "./cache";
import { createAurionError, isAurionError } from "./errors";
import { parseAbsences, toAurionAbsence } from "./parsers/absences";
import { parseFormId, parseFormIdGrade, parseGrades, toAurionGrade } from "./parsers/grades";
import {
	parseEventDetails,
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
} from "./parsers/planning";
import { parseDateOrThrow, parseIdInit, parseMenuId, parseViewState } from "./parsers/shared";
import { AurionTransport } from "./transport";
import type {
	AurionCacheStore,
	AurionAbsence,
	AurionGrade,
	AurionPlanningEvent,
	AurionPlanningEventDetails,
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
const PRIMEFACES_AJAX_HEADERS = {
	...FORM_URLENCODED_HEADERS,
	Accept: "application/xml, text/xml, */*; q=0.01",
	"Faces-Request": "partial/ajax",
	"X-Requested-With": "XMLHttpRequest",
} as const;

/**
 * Session Aurion de haut niveau, responsable de l'authentification,
 * de la navigation dans l'interface et de la récupération des données SDK.
 *
 * C'est le point d'entrée principal du SDK pour ouvrir une session puis
 * récupérer les notes, le planning et les absences de l'utilisateur
 * authentifié, avec un cache optionnel partagé avec la couche HTTP.
 */
export class AurionSession {
	/** Identifiant Aurion utilisé pour ouvrir la session distante. */
	readonly username: string;
	/** Mot de passe transmis à Aurion lors de l'authentification. */
	readonly password: string;
	/** Indique si un store de cache est configuré pour cette session. */
	readonly cache: boolean;
	/** Store de cache effectivement utilisé par la session et par le transport HTTP. */
	readonly cacheStore: AurionCacheStore | null;
	/** URL de base de l'instance Aurion ciblée par la session. */
	readonly baseUrl: string;
	private readonly transport: AurionTransport;
	private readonly sessionCacheMaxAgeMs?: number;
	private readonly planningTimeRangeApproximationMs?: number;
	private readonly navigationNodes = new Map<AurionNavigationNodeId, AurionNavigationNode>();

	/**
	 * Initialise une session cliente à partir des options fournies.
	 *
	 * Les appels réseau ne sont pas déclenchés au constructeur ; l'authentification
	 * réelle a lieu lors du premier appel qui doit contacter Aurion, par exemple
	 * via {@link getGrades}, {@link getPlanning} ou {@link getAbsences}.
	 *
	 * Le cache éventuel est normalisé ici puis partagé entre les valeurs mises en
	 * cache par la session et les réponses HTTP du transport.
	 *
	 * @param options Paramètres de session nécessaires pour cibler Aurion.
	 */
	constructor(options: AurionSessionOptions) {
		const cacheConfig = resolveAurionCacheConfig(options.cache);

		this.username = options.username;
		this.password = options.password;
		this.cache = cacheConfig.store !== null;
		this.cacheStore = cacheConfig.store;
		this.baseUrl = options.baseUrl ?? DEFAULT_AURION_BASE_URL;
		this.sessionCacheMaxAgeMs = cacheConfig.sessionMaxAgeMs;
		this.planningTimeRangeApproximationMs = cacheConfig.planningTimeRangeApproximationMs;
		this.transport = new AurionTransport({
			username: this.username,
			password: this.password,
			cacheStore: this.cacheStore,
			cacheMaxAgeMs: cacheConfig.transportMaxAgeMs,
			baseUrl: this.baseUrl,
			fetchFn: options.fetchFn,
		});
	}

	/**
	 * Récupère les notes Aurion puis les convertit en structure typée.
	 *
	 * La méthode gère automatiquement l'authentification, la navigation interne
	 * dans l'interface Aurion et la normalisation des valeurs retournées. Si un
	 * cache de session est configuré, une valeur encore valide peut être renvoyée
	 * directement ; une entrée expirée est supprimée puis recalculée.
	 *
	 * @returns La liste des notes normalisées disponibles pour le compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou le parsing échoue.
	 */
	async getGrades(): Promise<AurionGrade[]> {
		const cacheKey = createAurionValueCacheKey("session", `${this.getSessionCacheScope()}:grades`);

		try {
			const cached = await this.readCachedValue<AurionGrade[]>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login();

			const rawGrades = await this.withNavigationRetry("gradesPage", async () => {
				const state = await this.resolveGradesPageNode();

				return this.postGrade(state);
			});

			const grades = rawGrades.map((rawGrade) => toAurionGrade(rawGrade));
			await this.writeCachedValue(cacheKey, grades);

			return grades;
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

	/**
	 * Récupère les événements de planning Aurion sur une fenêtre temporelle donnée.
	 *
	 * La méthode orchestre l'authentification, la navigation JSF jusqu'à la page
	 * de planning puis le parsing du payload d'événements renvoyé par Aurion. Le
	 * cache de session tient compte de la fenêtre demandée ; une entrée expirée est
	 * invalidée puis remplacée par une nouvelle lecture.
	 *
	 * @param options Bornes temporelles optionnelles en objets natifs `Date`.
	 * @returns La liste des événements de planning normalisés.
	 * @throws {AurionError} Si une étape réseau, de navigation ou de parsing échoue.
	 */
	async getPlanning(options?: AurionPlanningOptions): Promise<AurionPlanningEvent[]> {
		const exactWindow = resolvePlanningWindow(options);
		const cacheWindow = approximatePlanningWindow(
			exactWindow,
			this.planningTimeRangeApproximationMs,
		);
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:planning:${serializePlanningWindow(cacheWindow)}`,
		);

		try {
			const cached =
				await this.readCachedValue<Array<Omit<AurionPlanningEvent, "getDetails">>>(cacheKey);
			if (cached) {
				return filterPlanningEventsByWindow(this.attachEventMethods(cached), exactWindow);
			}

			await this.transport.login();

			const planningDate = new Date(cacheWindow.startTimestamp);
			const today = planningDate.toLocaleDateString("fr-FR", {
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
			});
			const week = String(getWeekNumber(planningDate)).padStart(2, "0");
			const year = String(planningDate.getFullYear());

			const response = await this.withNavigationRetry("planningPage", async () => {
				const state = await this.resolvePlanningPageNode();

				return this.postPlanning(
					state,
					cacheWindow.startTimestamp,
					cacheWindow.endTimestamp,
					today,
					week,
					year,
				);
			});

			const planning = parsePlanningEvents(response.body);
			await this.writeCachedValue(cacheKey, planning);

			return filterPlanningEventsByWindow(this.attachEventMethods(planning), exactWindow);
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

	/**
	 * Récupère les détails complets d'un événement de planning Aurion.
	 *
	 * Cette méthode reproduit l'action PrimeFaces `eventSelect` du calendrier pour
	 * faire rendre la modale `form:modaleDetail`, puis parse son contenu.
	 *
	 * @param eventId Identifiant de l'événement à détailler.
	 * @returns Les détails complets affichés par Aurion pour cet événement.
	 * @throws {AurionError} Si la navigation, la requête AJAX ou le parsing échoue.
	 */
	async getEventDetails(eventId: string): Promise<AurionPlanningEventDetails> {
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:eventDetails:${eventId}`,
		);

		try {
			const cached = await this.readCachedValue<AurionPlanningEventDetails>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login();

			const response = await this.withNavigationRetry("planningPage", async () => {
				const state = await this.resolvePlanningPageNode();

				return this.postEventDetails(state, eventId);
			});

			const details = parseEventDetails(response.body, eventId);
			await this.writeCachedValue(cacheKey, details);

			return details;
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des détails d'événement Aurion.",
				error,
			);
		}
	}

	/**
	 * Récupère les absences Aurion puis les convertit en structure typée.
	 *
	 * Le flux inclut l'ouverture de session, la navigation vers la rubrique
	 * « Mes absences » puis l'extraction tabulaire des lignes retournées. Si un
	 * cache de session est actif, une valeur valide peut être réutilisée ; une
	 * entrée expirée est supprimée avant de relancer la récupération.
	 *
	 * @returns La liste des absences normalisées du compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou le parsing échoue.
	 */
	async getAbsences(): Promise<AurionAbsence[]> {
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:absences`,
		);

		try {
			const cached = await this.readCachedValue<AurionAbsence[]>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login();

			const rawAbsences = await this.withNavigationRetry("absencesPage", async () => {
				const state = await this.resolveAbsencesPageNode();

				return this.postAbsencesTable(state);
			});

			const absences = rawAbsences.map((rawAbsence) => toAurionAbsence(rawAbsence));
			await this.writeCachedValue(cacheKey, absences);

			return absences;
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

	/**
	 * Charge la page initiale et extrait les identifiants de session JSF.
	 *
	 * @param state État de navigation des notes à compléter.
	 * @returns Une promesse résolue une fois les identifiants racine chargés.
	 * @throws {AurionError} Si la page initiale ou ses identifiants JSF ne peuvent pas être récupérés.
	 */
	private async initializeSession(state: GradesNavigationState): Promise<void> {
		await this.initializeRootNavigationState(state, {
			includeFormId: true,
		});
	}

	private async resolveRootNavigationNode(options: {
		includeFormId: boolean;
	}): Promise<RootNavigationState> {
		const cached = this.readNavigationNode<RootNavigationState>("root");
		if (cached && (!options.includeFormId || cached.formId)) {
			return cached;
		}

		if (cached) {
			this.invalidateNavigationNode("root");
		}

		const state: RootNavigationState = {
			viewState: "",
			idInit: "",
		};

		await this.initializeRootNavigationState(state, options);
		this.writeNavigationNode("root", null, state);

		return state;
	}

	private async resolveGradesMenuNode(): Promise<GradesMenuNavigationState> {
		const cached = this.readNavigationNode<GradesMenuNavigationState>("gradesMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: true,
		});
		const state: GradesMenuNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			formId: requireRootFormId(root),
			menuId: "",
		};

		await this.postMainMenu(state);
		this.writeNavigationNode("gradesMenu", "root", state);

		return state;
	}

	private async resolveGradesPageNode(): Promise<GradesNavigationState> {
		const cached = this.readNavigationNode<GradesNavigationState>("gradesPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolveGradesMenuNode();
		const state: GradesNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			formId: menu.formId,
			menuId: menu.menuId,
			formIdGrade: "",
		};

		await this.postMainSidebar(state);
		this.writeNavigationNode("gradesPage", "gradesMenu", state);

		return state;
	}

	private async resolvePlanningMenuNode(): Promise<PlanningMenuNavigationState> {
		const cached = this.readNavigationNode<PlanningMenuNavigationState>("planningMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: false,
		});
		const state: PlanningMenuNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			menuId: "",
		};

		await this.loadPlanningSidebarMenuId(state);
		this.writeNavigationNode("planningMenu", "root", state);

		return state;
	}

	private async resolvePlanningPageNode(): Promise<PlanningNavigationState> {
		const cached = this.readNavigationNode<PlanningNavigationState>("planningPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolvePlanningMenuNode();
		const state: PlanningNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			menuId: menu.menuId,
			formIdPlanning: "",
		};

		await this.postSidebarNavigation(state, "getPlanning:postMainSidebar");
		await this.loadPlanningFormState(state);
		this.writeNavigationNode("planningPage", "planningMenu", state);

		return state;
	}

	private async resolveAbsencesMenuNode(): Promise<AbsencesNavigationState> {
		const cached = this.readNavigationNode<AbsencesNavigationState>("absencesMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: true,
		});
		const state: AbsencesNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			formId: requireRootFormId(root),
			menuId: "",
		};

		await this.postAbsencesMainMenu(state);
		this.writeNavigationNode("absencesMenu", "root", state);

		return state;
	}

	private async resolveAbsencesPageNode(): Promise<AbsencesNavigationState> {
		const cached = this.readNavigationNode<AbsencesNavigationState>("absencesPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolveAbsencesMenuNode();
		const state: AbsencesNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			formId: menu.formId,
			menuId: menu.menuId,
		};

		await this.postSidebarNavigation(state, "getAbsences:postMainSidebar");
		await this.loadAbsencesPageState(state);
		this.writeNavigationNode("absencesPage", "absencesMenu", state);

		return state;
	}

	/**
	 * Ouvre le sous-menu principal qui mène à la zone des notes.
	 *
	 * @param state État de navigation des notes contenant les identifiants JSF actifs.
	 * @returns Une promesse résolue lorsque l'identifiant de menu latéral est disponible.
	 * @throws {AurionError} Si la navigation JSF du menu principal échoue.
	 */
	private async postMainMenu(state: GradesMenuNavigationState): Promise<void> {
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

	/**
	 * Navigue vers ChoixIndividu et prépare l'identifiant de table des notes.
	 *
	 * @param state État de navigation des notes à enrichir.
	 * @returns Une promesse résolue une fois la page intermédiaire chargée.
	 * @throws {AurionError} Si la navigation vers la page des notes échoue.
	 */
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

	/**
	 * Charge l'écran principal puis extrait l'identifiant de menu « Mon Planning ».
	 *
	 * @param state État de navigation du planning à mettre à jour.
	 * @returns Une promesse résolue lorsque le menu planning est identifié.
	 * @throws {AurionError} Si l'écran principal ou le menu planning ne peuvent pas être lus.
	 */
	private async loadPlanningSidebarMenuId(state: PlanningMenuNavigationState): Promise<void> {
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

	/**
	 * Ouvre la page Planning et extrait les identifiants JSF requis pour la requête agenda.
	 *
	 * @param state État de navigation du planning à compléter.
	 * @returns Une promesse résolue lorsque l'état JSF du planning est prêt.
	 * @throws {AurionError} Si la page Planning ou ses identifiants ne peuvent pas être récupérés.
	 */
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
		state.dateInput = parseInputValue(response.body, "form:date_input");
		state.weekInput = parseInputValue(response.body, "form:week");
	}

	/**
	 * Déclenche l'appel PrimeFaces du composant agenda pour récupérer les événements.
	 *
	 * @param state État de navigation du planning contenant les identifiants JSF actifs.
	 * @param startTimestamp Borne de début de la fenêtre de planning en millisecondes Unix.
	 * @param endTimestamp Borne de fin de la fenêtre de planning en millisecondes Unix.
	 * @param today Date de référence formatée pour le champ calendrier.
	 * @param week Numéro de semaine sur deux chiffres.
	 * @param year Année civile associée à la semaine envoyée.
	 * @returns Un objet contenant le corps brut renvoyé par Aurion pour la requête d'agenda.
	 * @throws {AurionError} Si l'appel PrimeFaces du planning échoue.
	 */
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

	/**
	 * Déclenche l'action PrimeFaces `eventSelect` du planning pour rendre la modale de détails.
	 *
	 * @param state État de navigation du planning contenant les identifiants JSF actifs.
	 * @param eventId Identifiant d'événement sélectionné.
	 * @returns Un objet contenant le corps XML partiel renvoyé par Aurion.
	 * @throws {AurionError} Si l'appel PrimeFaces échoue.
	 */
	private async postEventDetails(
		state: PlanningNavigationState,
		eventId: string,
	): Promise<{ body: string }> {
		const sourceId = state.formIdPlanning;
		const fallbackDate = new Date();
		const today = fallbackDate.toLocaleDateString("fr-FR", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
		});
		const week = String(getWeekNumber(fallbackDate)).padStart(2, "0");
		const year = String(fallbackDate.getFullYear());
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": sourceId,
			"javax.faces.partial.execute": sourceId,
			"javax.faces.partial.render": "form:modaleDetail form:confirmerSuppression",
			"javax.faces.behavior.event": "eventSelect",
			"javax.faces.partial.event": "eventSelect",
			[`${sourceId}_selectedEventId`]: eventId,
			...createMainMenuCommonFields(state.idInit, "1605"),
			"form:date_input": state.dateInput ?? today,
			"form:week": state.weekInput ?? `${week}-${year}`,
			[`${sourceId}_view`]: "agendaWeek",
			"form:offsetFuseauNavigateur": "-7200000",
			"form:onglets_activeIndex": "0",
			"form:onglets_scrollState": "0",
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "POST",
			body: postData,
			headers: PRIMEFACES_AJAX_HEADERS,
			cache: false,
		});

		assertNavigationSuccess("getEventDetails:postEventSelect", response.status, response.url);

		return {
			body: response.body,
		};
	}

	/**
	 * Ouvre le sous-menu principal puis cible l'entrée de navigation « Mes absences ».
	 *
	 * @param state État de navigation des absences à enrichir.
	 * @returns Une promesse résolue lorsque l'entrée « Mes absences » est ciblée.
	 * @throws {AurionError} Si la navigation JSF du menu principal échoue.
	 */
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

	/**
	 * Charge la page MesAbsences et met à jour les champs de contexte JSF actifs.
	 *
	 * @param state État de navigation des absences à mettre à jour.
	 * @returns Une promesse résolue lorsque la page des absences est chargée.
	 * @throws {AurionError} Si la page MesAbsences ou ses identifiants ne peuvent pas être récupérés.
	 */
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

	/**
	 * Exécute la requête de pagination de la table d'absences et parse les lignes HTML.
	 *
	 * @param state État de navigation des absences contenant le contexte JSF actif.
	 * @returns Les lignes brutes d'absences extraites de la réponse HTML.
	 * @throws {AurionError} Si la requête ou le parsing de la table échoue.
	 */
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

	/**
	 * Déclenche la requête PrimeFaces qui renvoie les lignes de notes.
	 *
	 * @param state État de navigation des notes contenant l'identifiant de table.
	 * @returns Les lignes brutes de notes renvoyées par Aurion.
	 * @throws {AurionError} Si la requête ou le parsing des notes échoue.
	 */
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

	/**
	 * Initialise les identifiants de navigation communs depuis la racine Aurion.
	 *
	 * @param state Structure d'état à peupler avec les identifiants racine.
	 * @param options Indique notamment s'il faut extraire aussi l'identifiant de formulaire.
	 * @returns Une promesse résolue lorsque l'état racine est initialisé.
	 * @throws {AurionError} Si la page racine ou ses identifiants JSF sont indisponibles.
	 */
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

	/**
	 * Soumet une navigation latérale sur MainMenuPage à partir d'un `menuId` déjà résolu.
	 *
	 * @param state État de navigation contenant `viewState`, `idInit` et `menuId`.
	 * @param step Nom logique de l'étape de navigation pour le reporting d'erreur.
	 * @returns Une promesse résolue lorsque la soumission latérale a abouti.
	 * @throws {AurionError} Si la navigation latérale échoue.
	 */
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

	private async withNavigationRetry<TValue>(
		nodeId: AurionNavigationNodeId,
		action: () => Promise<TValue>,
	): Promise<TValue> {
		try {
			return await action();
		} catch (error: unknown) {
			if (!isAurionError(error) || !isRecoverableNavigationError(error.code)) {
				throw error;
			}

			this.invalidateNavigationNode(nodeId);
			this.invalidateNavigationNode("root");

			return action();
		}
	}

	private readNavigationNode<TState>(id: AurionNavigationNodeId): TState | null {
		const node = this.navigationNodes.get(id);
		if (!node) {
			return null;
		}

		return node.state as TState;
	}

	private writeNavigationNode<TState>(
		id: AurionNavigationNodeId,
		parentId: AurionNavigationNodeId | null,
		state: TState,
	): void {
		this.navigationNodes.set(id, {
			id,
			parentId,
			createdAt: Date.now(),
			state,
		});
	}

	private invalidateNavigationNode(id: AurionNavigationNodeId): void {
		this.navigationNodes.delete(id);

		for (const node of Array.from(this.navigationNodes.values())) {
			if (node.parentId === id) {
				this.invalidateNavigationNode(node.id);
			}
		}
	}

	private async readCachedValue<TValue>(key: string): Promise<TValue | null> {
		if (!this.cacheStore) {
			return null;
		}

		const entry = await this.cacheStore.get(key);
		if (!isAurionValueCacheEntry(entry)) {
			return null;
		}

		if (isAurionCacheEntryExpired(entry, this.sessionCacheMaxAgeMs)) {
			await this.cacheStore.delete(key);
			return null;
		}

		return entry.value as TValue;
	}

	private async writeCachedValue<TValue>(key: string, value: TValue): Promise<void> {
		if (!this.cacheStore) {
			return;
		}

		await this.cacheStore.set(key, {
			kind: "value",
			createdAt: Date.now(),
			value,
		});
	}

	private getSessionCacheScope(): string {
		return `${this.baseUrl}:${this.username}`;
	}

	private attachEventMethods(
		events: Array<Omit<AurionPlanningEvent, "getDetails">>,
	): AurionPlanningEvent[] {
		return events.map((event) => ({
			...event,
			getDetails: () => this.getEventDetails(event.id),
		}));
	}
}

/** État intermédiaire propagé entre les étapes de navigation Aurion. */
interface RootNavigationState {
	viewState: string;
	idInit: string;
	formId?: string;
}

/** État du menu Notes résolu depuis la racine de session. */
interface GradesMenuNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
}

/** État du menu Planning résolu depuis la racine de session. */
interface PlanningMenuNavigationState {
	viewState: string;
	menuId: string;
	idInit: string;
}

interface GradesNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
	formIdGrade: string;
}

/** État intermédiaire utilisé pendant la navigation de la section planning. */
interface PlanningNavigationState {
	viewState: string;
	menuId: string;
	idInit: string;
	formIdPlanning: string;
	dateInput?: string | null;
	weekInput?: string | null;
}

/** État intermédiaire utilisé pendant la navigation de la section absences. */
interface AbsencesNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
}

type AurionNavigationNodeId =
	| "root"
	| "gradesMenu"
	| "gradesPage"
	| "planningMenu"
	| "planningPage"
	| "absencesMenu"
	| "absencesPage";

interface AurionNavigationNode {
	id: AurionNavigationNodeId;
	parentId: AurionNavigationNodeId | null;
	createdAt: number;
	state: unknown;
}

/**
 * Valide qu'une étape HTTP de navigation Aurion a réussi.
 *
 * @param step Nom de l'étape métier en cours.
 * @param status Code HTTP renvoyé par Aurion.
 * @param url URL finale atteinte pendant cette étape.
 * @returns Rien ; l'absence d'exception indique que la navigation est valide.
 * @throws {AurionError} Si le statut HTTP n'appartient pas à la famille 2xx.
 */
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

function requireRootFormId(state: RootNavigationState): string {
	if (state.formId) {
		return state.formId;
	}

	throw createAurionError(
		"AURION_NAVIGATION_ERROR",
		"Identifiant de formulaire racine Aurion indisponible.",
		{
			parser: "requireRootFormId",
		},
	);
}

function isRecoverableNavigationError(code: string): boolean {
	return code === "AURION_NAVIGATION_ERROR" || code === "AURION_PARSING_ERROR";
}

/**
 * Construit les champs JSF communs attendus par les POST de navigation Aurion.
 *
 * @param idInit Identifiant JSF racine extrait de la page courante.
 * @param largeurDivCenter Largeur de conteneur à réinjecter dans le formulaire Aurion.
 * @returns Les champs communs à inclure dans les soumissions JSF Aurion.
 */
function createMainMenuCommonFields(
	idInit: string,
	largeurDivCenter = "885",
): Record<string, string> {
	return {
		form: "form",
		"form:largeurDivCenter": largeurDivCenter,
		"form:idInit": idInit,
		"form:sauvegarde": "",
	};
}

/**
 * Génère le couple focus/input PrimeFaces requis pour simuler le contexte utilisateur.
 *
 * @param focusField Nom du champ de focus PrimeFaces.
 * @param inputField Nom du champ d'entrée PrimeFaces associé.
 * @returns Les champs à injecter dans le formulaire pour reproduire le contexte utilisateur.
 */
function createFormFocusAndInputFields(
	focusField: string,
	inputField: string,
): Record<string, string> {
	return {
		[focusField]: "",
		[inputField]: AURION_USER_CONTEXT_ID,
	};
}

function parseInputValue(body: string, name: string): string | null {
	const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = body.match(
		new RegExp(`<input[^>]*name=["']${escapedName}["'][^>]*value=["']([^"']*)["']`, "i"),
	);

	return match?.[1] ?? null;
}

/**
 * Résout la fenêtre temporelle de planning à partir des options ou des valeurs par défaut SDK.
 *
 * @param options Fenêtre temporelle optionnelle demandée par l'appelant.
 * @returns Les bornes de début et de fin converties en timestamps Unix.
 * @throws {AurionError} Si une date fournie dans les options n'est pas valide.
 */
function resolvePlanningWindow(options?: AurionPlanningOptions): {
	startTimestamp: number;
	endTimestamp: number;
} {
	const parser = "resolvePlanningWindow";
	const body = JSON.stringify(options ?? {});

	const startDate = options?.start
		? parseDateOrThrow(body, parser, "start", options.start)
		: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const endDate = options?.end
		? parseDateOrThrow(body, parser, "end", options.end)
		: new Date(startDate.getTime() + 60 * 24 * 60 * 60 * 1000);

	const startTimestamp = startDate.getTime();
	const endTimestamp = endDate.getTime();

	return {
		startTimestamp,
		endTimestamp,
	};
}

/**
 * Calcule le numéro de semaine civile utilisé par le formulaire Planning Aurion.
 *
 * @param date Date de référence à convertir en numéro de semaine.
 * @returns Le numéro de semaine civile calculé.
 */
function getWeekNumber(date: Date): number {
	const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
	const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;

	return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

function approximatePlanningWindow(
	window: {
		startTimestamp: number;
		endTimestamp: number;
	},
	approximationMs: number | undefined,
): {
	startTimestamp: number;
	endTimestamp: number;
} {
	if (approximationMs === undefined) {
		return window;
	}

	return {
		startTimestamp: Math.floor(window.startTimestamp / approximationMs) * approximationMs,
		endTimestamp: Math.ceil(window.endTimestamp / approximationMs) * approximationMs,
	};
}

function serializePlanningWindow(window: { startTimestamp: number; endTimestamp: number }): string {
	const start = new Date(window.startTimestamp).toISOString();
	const end = new Date(window.endTimestamp).toISOString();

	return `${start}:${end}`;
}

function filterPlanningEventsByWindow(
	events: AurionPlanningEvent[],
	window: {
		startTimestamp: number;
		endTimestamp: number;
	},
): AurionPlanningEvent[] {
	return events.filter((event) => {
		const eventStart = event.start.getTime();
		const eventEnd = event.end.getTime();

		return eventEnd > window.startTimestamp && eventStart < window.endTimestamp;
	});
}
