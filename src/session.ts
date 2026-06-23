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
	parseFormIdPlanning,
	parsePlanningEvents,
	parseSidebarMenuIdForMonPlanning,
	parseEventDetails,
} from "./parsers/planning";
import {
	parseDateOrThrow,
	parseIdInit,
	parseMenuId,
	parseViewState,
	extractTags,
	extractElementBlocks,
	stripTags,
	normalizeWhitespace,
} from "./parsers/shared";
import { parseSubmenuId, parseMenuChildren, parseAvailablePlannings } from "./parsers/promotions";
import {
	AurionPlanningGroup,
	AurionPlanningSubgroup,
	AurionAvailablePlanning,
	type AurionPlanningNavigator,
} from "./promotions";
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
	"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
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

			const requestContext = createPlanningRequestContext(
				options ? cacheWindow : null,
				state.planningPageBody,
			);

			const response = await this.postPlanning(
				state,
				requestContext.startTimestamp,
				requestContext.endTimestamp,
				requestContext.today,
				requestContext.week,
				requestContext.year,
			);

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
	 * Récupère les détails d'un événement de planning.
	 *
	 * @param eventId L'identifiant de l'événement.
	 * @returns Les détails de l'événement.
	 * @throws {AurionError} Si la récupération ou le parsing échoue.
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
			await this.postSidebarNavigation(state, "getEventDetails:postMainSidebar");
			await this.loadPlanningFormState(state);

			const sourceId = state.formIdPlanning;
			const postData = state.planningPageBody
				? createUrlSearchParamsFromForm(state.planningPageBody)
				: new URLSearchParams();

			const requestFields: Record<string, string> = {
				"javax.faces.partial.ajax": "true",
				"javax.faces.source": sourceId,
				"javax.faces.partial.execute": sourceId,
				"javax.faces.partial.render": "form:modaleDetail form:confirmerSuppression",
				"javax.faces.behavior.event": "eventSelect",
				"javax.faces.partial.event": "eventSelect",
				[`${sourceId}_selectedEventId`]: eventId,
				"javax.faces.ViewState": state.viewState,
			};

			overlayParams(postData, requestFields);

			const response = await this.transport.request({
				path: "/faces/Planning.xhtml",
				method: "POST",
				body: postData,
				headers: { ...PRIMEFACES_AJAX_HEADERS, Referer: `${this.baseUrl}/faces/Planning.xhtml` },
				cache: false,
			});

			assertNavigationSuccess("getEventDetails:postEventSelect", response.status, response.url);

			const details = parseEventDetails(response.body, eventId);
			await this.writeCachedValue(cacheKey, details);

			return details;
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des détails de l'événement.",
				error,
			);
		}
	}

	private attachEventMethods(
		events: Array<Omit<AurionPlanningEvent, "getDetails">>,
	): AurionPlanningEvent[] {
		return events.map((event) => ({
			...event,
			getDetails: () => this.getEventDetails(event.id),
		}));
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
	 * Charge les groupes racines de « Plannings Groupés par Promotion ».
	 *
	 * La méthode reproduit la navigation PrimeFaces du menu latéral Aurion en
	 * sérialisant le formulaire JSF courant, puis ouvre successivement « Les
	 * plannings » et « Plannings Groupés par Promotion ».
	 *
	 * @returns Les groupes de plannings directement disponibles à la racine du menu groupé.
	 * @throws {AurionError} Si la navigation Aurion échoue ou si le menu ne peut pas être parsé.
	 */
	async getPlanningsGroups(): Promise<AurionPlanningGroup[]> {
		await this.transport.login();

		const mainMenu = await this.loadMainMenuSnapshot("getPlanningsGroups:loadMainMenu");
		const planningsSubmenuId = parseSubmenuId(mainMenu.body, "Les plannings");
		const planningsMenu = await this.postMainMenuSubmenu(
			mainMenu,
			planningsSubmenuId,
			"getPlanningsGroups:openPlanningsMenu",
		);
		const groupedSubmenuId = parseSubmenuId(planningsMenu.body, "Plannings Groupés par Promotion");
		const groupedMenu = await this.postMainMenuSubmenu(
			planningsMenu,
			groupedSubmenuId,
			"getPlanningsGroups:openGroupedPlanningsMenu",
		);

		const children = parseMenuChildren(groupedMenu.body, groupedSubmenuId);
		return children.map(
			(entry) => new AurionPlanningGroup(entry.name, entry.id, this as AurionPlanningNavigator),
		);
	}

	/**
	 * Charge les enfants directs d'un groupe de plannings déjà identifié.
	 *
	 * @param submenuId Identifiant PrimeFaces `submenu_XXXXX` du groupe à ouvrir.
	 * @param preState État de navigation optionnel réutilisable lorsque le menu est déjà chargé.
	 * @returns Les sous-groupes terminaux contenus dans le groupe.
	 * @throws {AurionError} Si le sous-menu ne peut pas être ouvert ou analysé.
	 */
	async getSubgroups(
		submenuId: string,
		preState?: PlanningNavigationState,
	): Promise<AurionPlanningSubgroup[]> {
		await this.transport.login();

		const baseMenu = preState?.mainMenuBody
			? {
					body: preState.mainMenuBody,
					formBody: preState.mainMenuBody,
					viewState: preState.viewState,
					idInit: preState.idInit,
				}
			: await this.loadGroupedPlanningsMenuSnapshot("getSubgroups:prepareGroupedMenu");
		const response = await this.postMainMenuSubmenu(
			baseMenu,
			submenuId,
			"getSubgroups:openSubmenu",
		);

		const children = parseMenuChildren(response.body, submenuId);
		return children.map(
			(entry) => new AurionPlanningSubgroup(entry.name, entry.id, this as AurionPlanningNavigator),
		);
	}

	/**
	 * Charge les plannings disponibles pour un sous-groupe terminal.
	 *
	 * @param menuId Identifiant `form:sidebar_menuid` du sous-groupe terminal.
	 * @returns Les plannings sélectionnables dans la page `ChoixPlanning.xhtml`.
	 * @throws {AurionError} Si la page de choix ne peut pas être ouverte ou parsée.
	 */
	async getAvailablePlannings(menuId: string): Promise<AurionAvailablePlanning[]> {
		await this.transport.login();
		const choixPlanning = await this.openChoixPlanning(menuId, "getAvailablePlannings");
		const plannings = parseAvailablePlannings(choixPlanning.body);
		return plannings.map(
			(p) =>
				new AurionAvailablePlanning(
					p.name,
					p.code,
					p.label,
					p.validityEnd,
					p.kind,
					p.id,
					menuId,
					this,
				),
		);
	}

	/**
	 * Sélectionne un planning groupé et récupère ses événements.
	 *
	 * Cette méthode ouvre d'abord le sous-groupe dans `ChoixPlanning.xhtml`, sélectionne
	 * la ligne PrimeFaces demandée, puis réutilise la requête calendrier et le parseur
	 * existants pour obtenir les événements normalisés.
	 *
	 * @param menuId Identifiant du sous-groupe terminal dans le menu latéral.
	 * @param planningId Identifiant `data-rk` du planning à sélectionner.
	 * @param options Fenêtre temporelle optionnelle à appliquer au calendrier.
	 * @returns Les événements du planning sélectionné, filtrés sur la fenêtre demandée.
	 * @throws {AurionError} Si la sélection ou la lecture du calendrier échoue.
	 */
	async getPlanningForGroup(
		menuId: string,
		planningId: string,
		options?: AurionPlanningOptions,
	): Promise<AurionPlanningEvent[]> {
		const exactWindow = resolvePlanningWindow(options);
		const cacheWindow = approximatePlanningWindow(
			exactWindow,
			this.planningTimeRangeApproximationMs,
		);
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:planningGroup:${planningId}:${serializePlanningWindow(cacheWindow)}`,
		);

		try {
			const cached =
				await this.readCachedValue<Array<Omit<AurionPlanningEvent, "getDetails">>>(cacheKey);
			if (cached) {
				return filterPlanningEventsByWindow(this.attachEventMethods(cached), exactWindow);
			}

			await this.transport.login();

			const choixPlanning = await this.openChoixPlanning(menuId, "getPlanningForGroup");
			const planningPageBody = await this.openSelectedPlanning(
				choixPlanning.body,
				planningId,
				"getPlanningForGroup:postSelection",
			);
			const state: PlanningNavigationState = {
				viewState: parseViewState(planningPageBody),
				menuId,
				idInit: choixPlanning.idInit,
				formIdPlanning: parseFormIdPlanning(planningPageBody),
				planningPageBody,
			};

			const requestContext = createPlanningRequestContext(
				options ? cacheWindow : null,
				planningPageBody,
			);

			const response = await this.postPlanning(
				state,
				requestContext.startTimestamp,
				requestContext.endTimestamp,
				requestContext.today,
				requestContext.week,
				requestContext.year,
			);

			const planning = parsePlanningEvents(response.body);
			await this.writeCachedValue(cacheKey, planning);

			return filterPlanningEventsByWindow(this.attachEventMethods(planning), exactWindow);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération du planning de groupe.",
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

	/**
	 * Ouvre le sous-menu principal qui mène à la zone des notes.
	 *
	 * @param state État de navigation des notes contenant les identifiants JSF actifs.
	 * @returns Une promesse résolue lorsque l'identifiant de menu latéral est disponible.
	 * @throws {AurionError} Si la navigation JSF du menu principal échoue.
	 */
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
		state.planningPageBody = response.body;
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
			"form:largeurDivCenter": "",
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

		if (response.status < 200 || response.status >= 300) {
			throw createAurionError(
				"AURION_NAVIGATION_ERROR",
				"Navigation Aurion échouée à l'étape getPlanning:postPlanning.",
				{
					step: "getPlanning:postPlanning",
					status: response.status,
					url: response.url,
					expected: "2xx",
					sourceId,
					formFields: summarizePlanningFormFields(postData),
					scheduleSnippet: state.planningPageBody
						? extractScheduleWidgetSnippet(state.planningPageBody, sourceId)
						: null,
					responseSnippet: response.body.slice(0, 700),
				},
			);
		}
		if (response.body.includes("<error>")) {
			throw createAurionError(
				"AURION_PARSING_ERROR",
				"Aurion a rejeté la requête AJAX du composant planning.",
				{
					parser: "postPlanning",
					url: response.url,
					status: response.status,
					sourceId,
					formFields: summarizePlanningFormFields(postData),
					scheduleSnippet: state.planningPageBody
						? extractScheduleWidgetSnippet(state.planningPageBody, sourceId)
						: null,
					responseSnippet: response.body.slice(0, 500),
				},
			);
		}

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

	private async loadMainMenuSnapshot(step: string): Promise<MainMenuSnapshot> {
		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "GET",
			headers: { Referer: `${this.baseUrl}/` },
			cache: false,
		});

		assertNavigationSuccess(step, response.status, response.url);

		return {
			body: response.body,
			formBody: response.body,
			viewState: parseViewState(response.body),
			idInit: parseIdInit(response.body),
		};
	}

	private async loadGroupedPlanningsMenuSnapshot(step: string): Promise<MainMenuSnapshot> {
		const mainMenu = await this.loadMainMenuSnapshot(`${step}:loadMainMenu`);
		const planningsSubmenuId = parseSubmenuId(mainMenu.body, "Les plannings");
		const planningsMenu = await this.postMainMenuSubmenu(
			mainMenu,
			planningsSubmenuId,
			`${step}:openPlanningsMenu`,
		);
		const groupedSubmenuId = parseSubmenuId(planningsMenu.body, "Plannings Groupés par Promotion");

		return this.postMainMenuSubmenu(
			planningsMenu,
			groupedSubmenuId,
			`${step}:openGroupedPlanningsMenu`,
		);
	}

	private async postMainMenuSubmenu(
		menu: MainMenuSnapshot,
		submenuId: string,
		step: string,
	): Promise<MainMenuSnapshot> {
		const command = parseChargerSousMenuCommand(menu.formBody);
		const postData = createUrlSearchParamsFromForm(menu.formBody, command.formId);
		overlayParams(postData, {
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": command.sourceId,
			"javax.faces.partial.execute": command.executeId,
			"javax.faces.partial.render": command.renderId,
			[command.sourceId]: command.sourceId,
			"webscolaapp.Sidebar.ID_SUBMENU": submenuId,
			"javax.faces.ViewState": menu.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: PRIMEFACES_AJAX_HEADERS,
			cache: false,
		});

		assertNavigationSuccess(step, response.status, response.url);

		return {
			body: response.body,
			formBody: menu.formBody,
			viewState: parseViewState(response.body),
			idInit: menu.idInit,
		};
	}

	private async openChoixPlanning(menuId: string, step: string): Promise<ChoixPlanningSnapshot> {
		const mainMenu = await this.loadMainMenuSnapshot(`${step}:loadMainMenu`);
		const postData = createUrlSearchParamsFromForm(mainMenu.body);
		overlayParams(postData, {
			"javax.faces.ViewState": mainMenu.viewState,
			"form:sidebar": "form:sidebar",
			"form:sidebar_menuid": menuId,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess(`${step}:postSidebar`, response.status, response.url);

		if (response.url.endsWith("/faces/ChoixPlanning.xhtml")) {
			return {
				body: response.body,
				idInit: mainMenu.idInit,
			};
		}

		const choixResponse = await this.transport.request({
			path: "/faces/ChoixPlanning.xhtml",
			method: "GET",
			headers: { Referer: `${this.baseUrl}/faces/ChoixPlanning.xhtml` },
			cache: false,
		});

		assertNavigationSuccess(`${step}:loadChoixPlanning`, choixResponse.status, choixResponse.url);

		return {
			body: choixResponse.body,
			idInit: mainMenu.idInit,
		};
	}

	private async openSelectedPlanning(
		choixPlanningBody: string,
		planningId: string,
		step: string,
	): Promise<string> {
		const dataTableId = parseChoixPlanningDataTableId(choixPlanningBody);
		const buttonId = parseVoirPlanningButtonId(choixPlanningBody);
		const postData = createUrlSearchParamsFromForm(choixPlanningBody);
		overlayParams(postData, {
			"javax.faces.ViewState": parseViewState(choixPlanningBody),
			[`${dataTableId}_checkbox`]: "on",
			[`${dataTableId}_selection`]: planningId,
			[buttonId]: "",
		});

		const response = await this.transport.request({
			path: "/faces/ChoixPlanning.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
		});

		assertNavigationSuccess(step, response.status, response.url);
		if (!containsPlanningScheduleWidget(response.body)) {
			const planningResponse = await this.transport.request({
				path: "/faces/Planning.xhtml",
				method: "GET",
				headers: { Referer: `${this.baseUrl}/faces/ChoixPlanning.xhtml` },
				cache: false,
			});

			assertNavigationSuccess(
				`${step}:loadPlanning`,
				planningResponse.status,
				planningResponse.url,
			);
			if (!containsPlanningScheduleWidget(planningResponse.body)) {
				throw createAurionError(
					"AURION_PARSING_ERROR",
					"La sélection du planning groupé n'a pas ouvert la page calendrier Aurion.",
					{
						parser: "openSelectedPlanning",
						planningId,
						dataTableId,
						buttonId,
						selectionField: `${dataTableId}_selection`,
						selectionPost: {
							status: response.status,
							initialStatus: response.initialStatus,
							url: response.url,
							title: extractPageTitle(response.body),
							bodySnippet: response.body.slice(0, 500),
						},
						fallbackGet: {
							status: planningResponse.status,
							initialStatus: planningResponse.initialStatus,
							url: planningResponse.url,
							title: extractPageTitle(planningResponse.body),
							bodySnippet: planningResponse.body.slice(0, 500),
						},
					},
				);
			}

			return planningResponse.body;
		}

		return response.body;
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
}

/** État intermédiaire propagé entre les étapes de navigation Aurion. */
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
	formId?: string;
	mainMenuBody?: string;
	planningPageBody?: string;
}

interface MainMenuSnapshot {
	body: string;
	formBody: string;
	viewState: string;
	idInit: string;
}

interface ChargerSousMenuCommand {
	sourceId: string;
	formId: string;
	executeId: string;
	renderId: string;
}

interface ChoixPlanningSnapshot {
	body: string;
	idInit: string;
}

interface PlanningRequestContext {
	startTimestamp: number;
	endTimestamp: number;
	today: string;
	week: string;
	year: string;
}

/** État intermédiaire utilisé pendant la navigation de la section absences. */
interface AbsencesNavigationState {
	viewState: string;
	formId: string;
	menuId: string;
	idInit: string;
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

/**
 * Extrait la commande PrimeFaces `chargerSousMenu` de la page MainMenuPage.
 *
 * Cette commande indique les identifiants nécessaires pour soumettre une requête AJAX
 * permettant d'ouvrir un sous-menu latéral.
 *
 * @param body Le corps HTML de la page.
 * @returns Les identifiants `sourceId`, `formId`, `executeId` et `renderId` requis.
 * @throws {AurionError} Si la commande est introuvable ou mal formée.
 */
function parseChargerSousMenuCommand(body: string): ChargerSousMenuCommand {
	const commandIndex = body.indexOf("chargerSousMenu");
	const primeFacesIndex =
		commandIndex === -1
			? body.indexOf("PrimeFaces.ab")
			: body.indexOf("PrimeFaces.ab", commandIndex);
	if (primeFacesIndex === -1) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			"Impossible de localiser la commande PrimeFaces chargerSousMenu.",
			{ parser: "parseChargerSousMenuCommand" },
		);
	}

	const config = body.slice(primeFacesIndex, primeFacesIndex + 3000);
	const sourceId = parsePrimeFacesStringConfig(config, "s", "parseChargerSousMenuCommand");
	const formId = parsePrimeFacesStringConfig(config, "f", "parseChargerSousMenuCommand");
	const executeId = parsePrimeFacesStringConfig(config, "p", "parseChargerSousMenuCommand");
	const renderId = parsePrimeFacesStringConfig(config, "u", "parseChargerSousMenuCommand");

	return { sourceId, formId, executeId, renderId };
}

/**
 * Parse une valeur de configuration sous forme de chaîne de caractères dans un appel `PrimeFaces.ab`.
 *
 * @param config L'extrait de code JavaScript contenant la configuration.
 * @param key La clé à rechercher (ex: `s`, `f`, `p`, `u`).
 * @param parser Nom du parseur pour le rapport d'erreur.
 * @returns La valeur associée à la clé.
 * @throws {AurionError} Si la clé est introuvable.
 */
function parsePrimeFacesStringConfig(config: string, key: string, parser: string): string {
	const match = config.match(new RegExp(`${key}:"([^"]+)"`));
	if (!match?.[1]) {
		throw createAurionError("AURION_PARSING_ERROR", `Champ PrimeFaces ${key} introuvable.`, {
			parser,
			key,
			configSnippet: config.slice(0, 280),
		});
	}

	return match[1];
}

/**
 * Construit un objet `URLSearchParams` à partir des champs d'un formulaire HTML.
 *
 * Cette fonction extrait les champs `input`, `textarea` et `select` (en respectant l'état
 * de sélection pour les cases à cocher, boutons radio et menus déroulants) afin de
 * reproduire la sérialisation JSF native.
 *
 * @param body Le corps HTML contenant le formulaire.
 * @param formId L'identifiant (attribut `id` ou `name`) du formulaire cible.
 * @returns Les paramètres encodés prêts à être envoyés en POST.
 * @throws {AurionError} Si le formulaire est introuvable.
 */
function createUrlSearchParamsFromForm(body: string, formId = "form"): URLSearchParams {
	const formBlock = extractFormBlock(body, formId);
	const params = new URLSearchParams();
	params.set(formId, formId);

	for (const input of extractTags(formBlock, "input")) {
		const attributes = parseHtmlAttributes(input);
		const name = attributes.get("name");
		if (!name) {
			continue;
		}

		const type = attributes.get("type")?.toLowerCase() ?? "text";
		if ((type === "checkbox" || type === "radio") && !attributes.has("checked")) {
			continue;
		}

		params.set(name, attributes.get("value") ?? "");
	}

	for (const textarea of extractElementBlocks(formBlock, "textarea")) {
		const openingTagEnd = textarea.indexOf(">");
		const openingTag = textarea.slice(0, openingTagEnd + 1);
		const attributes = parseHtmlAttributes(openingTag);
		const name = attributes.get("name");
		if (!name) {
			continue;
		}

		const value = textarea.slice(openingTagEnd + 1, textarea.lastIndexOf("</textarea>"));
		params.set(name, decodeHtmlAttribute(value));
	}

	for (const select of extractElementBlocks(formBlock, "select")) {
		const openingTagEnd = select.indexOf(">");
		const openingTag = select.slice(0, openingTagEnd + 1);
		const attributes = parseHtmlAttributes(openingTag);
		const name = attributes.get("name");
		if (!name) {
			continue;
		}

		const option = findSelectedOption(select) ?? findFirstOption(select);
		params.set(name, option ?? "");
	}

	return params;
}

/**
 * Extrait un bloc HTML complet représentant un formulaire donné, y compris son contenu.
 *
 * @param body Le document HTML.
 * @param formId L'identifiant ou le nom du formulaire.
 * @returns La balise de début du formulaire jusqu'à la balise de fin incluse.
 * @throws {AurionError} Si le formulaire n'est pas trouvé ou s'il s'agit d'une réponse partielle incomplète.
 */
function extractFormBlock(body: string, formId: string): string {
	const formOpenings = Array.from(body.matchAll(/<form\b[^>]*>/gi));
	for (const opening of formOpenings) {
		if (typeof opening.index !== "number") {
			continue;
		}

		const attributes = parseHtmlAttributes(opening[0]);
		if (attributes.get("id") !== formId && attributes.get("name") !== formId) {
			continue;
		}

		const closingIndex = body.indexOf("</form>", opening.index);
		if (closingIndex !== -1) {
			return body.slice(opening.index, closingIndex + "</form>".length);
		}
	}

	const firstForm = formOpenings.at(0);
	if (formId === "form" && firstForm && typeof firstForm.index === "number") {
		const closingIndex = body.indexOf("</form>", firstForm.index);
		if (closingIndex !== -1) {
			return body.slice(firstForm.index, closingIndex + "</form>".length);
		}
	}

	if (body.includes("<partial-response")) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			"Réponse partielle JSF reçue sans formulaire complet sérialisable.",
			{
				parser: "extractFormBlock",
				formId,
			},
		);
	}

	{
		throw createAurionError(
			"AURION_PARSING_ERROR",
			"Formulaire JSF introuvable dans la page Aurion.",
			{
				parser: "extractFormBlock",
				formId,
			},
		);
	}
}

/**
 * Analyse les attributs d'une balise HTML ouvrante.
 *
 * @param tag La balise ouvrante (ex: `<input type="text" name="foo">`).
 * @returns Une Map associant chaque nom d'attribut en minuscules à sa valeur décodée.
 */
function parseHtmlAttributes(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const match of tag.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
		const name = match[1];
		if (!name || name === tag.match(/^<\/?([\w-]+)/)?.[1]) {
			continue;
		}

		attributes.set(name.toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ""));
	}

	return attributes;
}

/**
 * Trouve la valeur de la première option explicitement sélectionnée dans un `<select>`.
 *
 * @param selectBlock Le bloc HTML du menu déroulant.
 * @returns La valeur de l'option (attribut `value` ou contenu texte), ou `null` si aucune n'est sélectionnée.
 */
function findSelectedOption(selectBlock: string): string | null {
	for (const option of extractElementBlocks(selectBlock, "option")) {
		const openingTag = option.slice(0, option.indexOf(">") + 1);
		const attributes = parseHtmlAttributes(openingTag);
		if (attributes.has("selected")) {
			return attributes.get("value") ?? decodeHtmlAttribute(stripTags(option));
		}
	}

	return null;
}

/**
 * Trouve la valeur de la toute première option d'un `<select>`.
 *
 * @param selectBlock Le bloc HTML du menu déroulant.
 * @returns La valeur de la première option, ou `null` si le `<select>` est vide.
 */
function findFirstOption(selectBlock: string): string | null {
	const option = extractElementBlocks(selectBlock, "option").at(0);
	if (!option) {
		return null;
	}

	const openingTag = option.slice(0, option.indexOf(">") + 1);
	const attributes = parseHtmlAttributes(openingTag);

	return attributes.get("value") ?? decodeHtmlAttribute(stripTags(option));
}

/**
 * Remplace ou ajoute des paramètres dans une instance `URLSearchParams`.
 *
 * @param params Les paramètres existants à muter.
 * @param values Un objet associatif clé-valeur contenant les paramètres à injecter.
 */
function overlayParams(params: URLSearchParams, values: Record<string, string>): void {
	for (const [key, value] of Object.entries(values)) {
		params.set(key, value);
	}
}

/**
 * Identifie l'identifiant racine (ex: `form:j_idt181`) du composant data-table contenant les plannings disponibles.
 *
 * @param body Le code HTML de la page `ChoixPlanning.xhtml`.
 * @returns L'identifiant de la table JSF.
 * @throws {AurionError} Si l'identifiant est introuvable.
 */
function parseChoixPlanningDataTableId(body: string): string {
	const match = body.match(/id="([^"]+)_data"[^>]*class="[^"]*ui-datatable-data/);
	if (!match?.[1]) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			"Table de sélection des plannings introuvable.",
			{
				parser: "parseChoixPlanningDataTableId",
			},
		);
	}

	return match[1];
}

/**
 * Extrait l'identifiant (id ou name) du bouton "Voir planning" à partir de son libellé visuel.
 *
 * @param body Le code HTML de la page `ChoixPlanning.xhtml`.
 * @returns L'identifiant du bouton JSF.
 * @throws {AurionError} Si le bouton n'est pas présent dans le DOM.
 */
function parseVoirPlanningButtonId(body: string): string {
	for (const button of extractElementBlocks(body, "button")) {
		if (normalizeWhitespace(stripTags(button)) !== "Voir planning") {
			continue;
		}

		const openingTag = button.slice(0, button.indexOf(">") + 1);
		const attributes = parseHtmlAttributes(openingTag);
		const id = attributes.get("id") ?? attributes.get("name");
		if (id) {
			return id;
		}
	}

	throw createAurionError("AURION_PARSING_ERROR", "Bouton Voir planning introuvable.", {
		parser: "parseVoirPlanningButtonId",
	});
}

/**
 * Détermine si le corps HTML contient le composant PrimeFaces Schedule (le calendrier).
 *
 * @param body Le code HTML (ou XML partiel) à vérifier.
 * @returns `true` si le widget de calendrier est présent, `false` sinon.
 */
function containsPlanningScheduleWidget(body: string): boolean {
	return /PrimeFaces\.cw\("Schedule","schedule",\{id:"[^"]+"/.test(body);
}

/**
 * Extrait le titre de la page contenu dans la balise `<title>`.
 *
 * @param body Le code HTML de la page.
 * @returns Le titre décodé et nettoyé, ou `null` si introuvable.
 */
function extractPageTitle(body: string): string | null {
	const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match?.[1]) {
		return null;
	}

	return decodeHtmlAttribute(stripTags(match[1]));
}

/**
 * Construit le contexte de requête nécessaire pour extraire les événements de planning
 * depuis la page calendrier.
 *
 * Cette fonction s'appuie sur une fenêtre temporelle explicite si elle est fournie,
 * ou calcule une fenêtre par défaut reflétant la vue mensuelle visible du calendrier
 * d'après l'état du formulaire rendu.
 *
 * @param window Fenêtre temporelle explicite (si précisée par l'appelant).
 * @param planningPageBody Le corps HTML de la page Planning (si déjà chargée).
 * @returns Le contexte de requête contenant timestamps, numéro de semaine et dates JSF.
 */
function createPlanningRequestContext(
	window: { startTimestamp: number; endTimestamp: number } | null,
	planningPageBody: string | undefined,
): PlanningRequestContext {
	if (window) {
		const planningDate = new Date(window.startTimestamp);
		return {
			startTimestamp: window.startTimestamp,
			endTimestamp: window.endTimestamp,
			today: planningDate.toLocaleDateString("fr-FR", {
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
			}),
			week: String(getWeekNumber(planningDate)).padStart(2, "0"),
			year: String(planningDate.getFullYear()),
		};
	}

	if (planningPageBody) {
		const params = createUrlSearchParamsFromForm(planningPageBody);
		const dateInput = params.get("form:date_input");
		const weekInput = params.get("form:week");
		if (dateInput && weekInput) {
			const [week, year] = weekInput.split("-");
			if (week && year) {
				const date = parseDateOrThrow(
					planningPageBody,
					"createPlanningRequestContext",
					"form:date_input",
					dateInput,
				);
				const visibleMonthRange = createMonthVisiblePlanningRange(date);

				return {
					startTimestamp: visibleMonthRange.startTimestamp,
					endTimestamp: visibleMonthRange.endTimestamp,
					today: dateInput,
					week,
					year,
				};
			}
		}
	}

	const fallbackWindow = resolvePlanningWindow();
	const fallbackDate = new Date(fallbackWindow.startTimestamp);
	return {
		startTimestamp: fallbackWindow.startTimestamp,
		endTimestamp: fallbackWindow.endTimestamp,
		today: fallbackDate.toLocaleDateString("fr-FR", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
		}),
		week: String(getWeekNumber(fallbackDate)).padStart(2, "0"),
		year: String(fallbackDate.getFullYear()),
	};
}

/**
 * Calcule l'intervalle temporel affiché dans une vue mois PrimeFaces classique
 * en entourant le début du mois courant.
 *
 * @param date Une date appartenant au mois cible.
 * @returns Les horodatages de début (souvent le dimanche précédent) et de fin (~40 jours plus tard).
 */
function createMonthVisiblePlanningRange(date: Date): {
	startTimestamp: number;
	endTimestamp: number;
} {
	const firstDayOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
	const visibleStart = new Date(firstDayOfMonth);
	visibleStart.setDate(firstDayOfMonth.getDate() - firstDayOfMonth.getDay());

	const visibleEnd = new Date(visibleStart);
	visibleEnd.setDate(visibleStart.getDate() + 40);

	return {
		startTimestamp: visibleStart.getTime(),
		endTimestamp: visibleEnd.getTime(),
	};
}

/**
 * Construit un résumé lisible de l'état des principaux champs JSF et PrimeFaces
 * (date, identifiants AJAX) soumis dans une requête Planning.
 *
 * Utile uniquement pour la génération de rapports d'erreurs en cas d'échec d'extraction.
 *
 * @param params Les paramètres de la requête POST.
 * @returns Un dictionnaire associant chaque clé d'intérêt à sa valeur, ou `false` si absente.
 */
function summarizePlanningFormFields(params: URLSearchParams): Record<string, string | boolean> {
	const summary: Record<string, string | boolean> = {};
	for (const key of [
		"javax.faces.partial.ajax",
		"javax.faces.source",
		"javax.faces.partial.execute",
		"javax.faces.partial.render",
		"form",
		"form:largeurDivCenter",
		"form:idInit",
		"form:date_input",
		"form:week",
		"form:offsetFuseauNavigateur",
		"form:onglets_activeIndex",
		"form:onglets_scrollState",
		"javax.faces.ViewState",
	]) {
		summary[key] = params.has(key) ? (params.get(key) ?? "") : false;
	}

	const sourceId = params.get("javax.faces.source");
	if (sourceId) {
		summary[`${sourceId}_start`] = params.get(`${sourceId}_start`) ?? false;
		summary[`${sourceId}_end`] = params.get(`${sourceId}_end`) ?? false;
		summary[`${sourceId}_view`] = params.get(`${sourceId}_view`) ?? false;
	}

	return summary;
}

/**
 * Extrait une portion de code HTML entourant l'identifiant du widget calendrier (schedule),
 * afin d'aider au diagnostic lors de la levée d'erreurs d'extraction.
 *
 * @param body Le document HTML de la page Planning.
 * @param sourceId L'identifiant du widget ciblé.
 * @returns Le fragment HTML textuel entourant l'élément, ou `null` s'il est introuvable.
 */
function extractScheduleWidgetSnippet(body: string, sourceId: string): string | null {
	const index = body.indexOf(sourceId);
	if (index === -1) {
		return null;
	}

	return body.slice(Math.max(0, index - 220), Math.min(body.length, index + 500));
}

/**
 * Remplace de manière basique quelques entités HTML classiques pour restaurer un texte brut.
 *
 * NOTE: Destiné exclusivement au traitement léger des textes internes. Ne gère pas
 * la spécification HTML de manière exhaustive.
 *
 * @param input La chaîne de caractères à décoder.
 * @returns La chaîne convertie.
 */
function decodeHtmlAttribute(input: string): string {
	return input
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
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

function filterPlanningEventsByWindow<T extends { start: Date; end: Date }>(
	events: T[],
	window: {
		startTimestamp: number;
		endTimestamp: number;
	},
): T[] {
	return events.filter((event) => {
		const eventStart = event.start.getTime();
		const eventEnd = event.end.getTime();

		return eventEnd > window.startTimestamp && eventStart < window.endTimestamp;
	});
}
