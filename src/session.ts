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
import { parseAvailablePlannings, parseMenuChildren, parseSubmenuId } from "./parsers/promotions";
import { parseDateOrThrow, parseIdInit, parseMenuId, parseViewState } from "./parsers/shared";
import { AurionAvailablePlanning, AurionPlanningGroup, AurionPlanningSubgroup } from "./promotions";
import { AurionTransport } from "./transport";
import type {
	AurionCacheStore,
	AurionAbsence,
	AurionGrade,
	AurionPlanningEvent,
	AurionPlanningEventDetails,
	AurionPlanningOptions,
	AurionRequestOptions,
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
	readonly #password: string;
	/** Indique si un store de cache est configuré pour cette session. */
	readonly cache: boolean;
	/** Store de cache effectivement utilisé par la session et par le transport HTTP. */
	readonly cacheStore: AurionCacheStore | null;
	/** URL de base de l'instance Aurion ciblée par la session. */
	readonly baseUrl: string;
	/** Client HTTP chargé des cookies, de l'authentification et des requêtes. */
	private readonly transport: AurionTransport;
	/** Durée de validité maximale des valeurs normalisées en cache. */
	private readonly sessionCacheMaxAgeMs?: number;
	/** Granularité utilisée pour rapprocher les fenêtres des clés de cache planning. */
	private readonly planningTimeRangeApproximationMs?: number;
	/** États JSF mis en cache pour la navigation standard entre les pages. */
	private readonly navigationNodes = new Map<AurionNavigationNodeId, AurionNavigationNode>();
	/** Instantanés des sous-menus de groupes de planning déjà parcourus. */
	private readonly planningGroupSnapshots = new Map<string, MainMenuSnapshot>();
	/** Relation entre chaque groupe et son sous-menu parent. */
	private readonly planningGroupParentIds = new Map<string, string>();
	/** Instantanés de la page de sélection des plannings, indexés par menu. */
	private readonly choixPlanningSnapshots = new Map<string, ChoixPlanningSnapshot>();
	/** Contexte nécessaire pour retrouver l'état JSF d'un événement de planning groupé. */
	private readonly eventPlanningContexts = new Map<
		string,
		{ menuId: string; planningId: string }
	>();

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
	 * @throws {TypeError} Si l'URL de base fournie ne peut pas être interprétée.
	 */
	constructor(options: AurionSessionOptions) {
		const cacheConfig = resolveAurionCacheConfig(options.cache);

		this.username = options.username;
		this.#password = options.password;
		this.cache = cacheConfig.store !== null;
		this.cacheStore = cacheConfig.store;
		this.baseUrl = options.baseUrl ?? DEFAULT_AURION_BASE_URL;
		this.sessionCacheMaxAgeMs = cacheConfig.sessionMaxAgeMs;
		this.planningTimeRangeApproximationMs = cacheConfig.planningTimeRangeApproximationMs;
		this.transport = new AurionTransport({
			username: this.username,
			password: this.#password,
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
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns La liste des notes normalisées disponibles pour le compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou le parsing échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé avant sa fin.
	 */
	async getGrades(options?: AurionRequestOptions): Promise<AurionGrade[]> {
		const cacheKey = createAurionValueCacheKey("session", `${this.getSessionCacheScope()}:grades`);

		try {
			throwIfAborted(options?.signal);
			const cached = await this.readCachedValue<AurionGrade[]>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login(options?.signal);

			const rawGrades = await this.withNavigationRetry("gradesPage", async () => {
				const state = await this.resolveGradesPageNode(options?.signal);

				return this.postGrade(state, options?.signal);
			});

			const grades = rawGrades.map((rawGrade) => toAurionGrade(rawGrade));
			await this.writeCachedValue(cacheKey, grades);

			return grades;
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

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
	 * @throws {RangeError} Si les dates sont invalides ou si la fin ne suit pas le début.
	 * @throws {AbortError} Si le signal de cet appel est annulé avant sa fin.
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
			throwIfAborted(options?.signal);
			const cached =
				await this.readCachedValue<Array<Omit<AurionPlanningEvent, "getDetails">>>(cacheKey);
			if (cached) {
				return filterPlanningEventsByWindow(this.attachEventMethods(cached), exactWindow);
			}

			await this.transport.login(options?.signal);

			const planningDate = new Date(cacheWindow.startTimestamp);
			const today = planningDate.toLocaleDateString("fr-FR", {
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
			});
			const week = String(getWeekNumber(planningDate)).padStart(2, "0");
			const year = String(planningDate.getFullYear());

			const response = await this.withNavigationRetry("planningPage", async () => {
				const state = await this.resolvePlanningPageNode(options?.signal);

				return this.postPlanning(
					state,
					cacheWindow.startTimestamp,
					cacheWindow.endTimestamp,
					today,
					week,
					year,
					options?.signal,
				);
			});

			const planning = parsePlanningEvents(response.body);
			await this.writeCachedValue(cacheKey, planning);

			return filterPlanningEventsByWindow(this.attachEventMethods(planning), exactWindow);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération du planning Aurion.",
				error,
			);
		}
	}

	/**
	 * Liste les groupes de plannings visibles dans la navigation Aurion.
	 *
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns Les groupes de plannings de promotion accessibles au compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou l'analyse du menu échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé avant sa fin.
	 */
	async getPlanningsGroups(options?: AurionRequestOptions): Promise<AurionPlanningGroup[]> {
		try {
			await this.transport.login(options?.signal);

			const root = await this.resolveRootNavigationNode({
				includeFormId: true,
				signal: options?.signal,
			});
			const rootBody = requireRootBody(root);
			const mainMenuSnapshot = await this.loadPlanningGroupSubmenu(
				MAIN_MENU_SUBMENU_ID,
				undefined,
				options?.signal,
			);
			const mainMenuBody = `${rootBody}\n${mainMenuSnapshot.body}`;
			let parentSnapshot = mainMenuSnapshot;
			let groupSubmenuId = tryParseSubmenuId(mainMenuBody, "Plannings Groupés par Promotion");

			if (!groupSubmenuId) {
				const planningsSubmenuId = parseSubmenuId(mainMenuBody, "Les plannings");
				const planningsSnapshot = await this.loadPlanningGroupSubmenu(
					planningsSubmenuId,
					undefined,
					options?.signal,
				);
				parentSnapshot = planningsSnapshot;
				groupSubmenuId =
					tryParseSubmenuId(planningsSnapshot.body, "Plannings Groupés par Promotion") ??
					planningsSubmenuId;
			}

			const snapshot = await this.loadPlanningGroupSubmenu(
				groupSubmenuId,
				parentSnapshot,
				options?.signal,
			);
			const children = parseMenuChildren(snapshot.body, groupSubmenuId);

			return children
				.filter((child) => child.type === "submenu")
				.map((child) => {
					this.planningGroupParentIds.set(child.id, groupSubmenuId);
					return new AurionPlanningGroup(child.name, child.id, this);
				});
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des groupes de planning Aurion.",
				error,
			);
		}
	}

	/**
	 * Récupère tous les plannings sélectionnables visibles dans les groupes de promotion.
	 * Les événements ne sont pas chargés : chaque planning retourné peut être lu
	 * individuellement avec `planning.getPlanning(options)`.
	 *
	 * @param options Options partagées avec les appels de navigation imbriqués.
	 * @returns Tous les plannings accessibles dans les groupes et sous-groupes.
	 * @throws {AurionError} Si l'authentification, la navigation ou l'analyse échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async getAllAvailablePlannings(
		options?: AurionRequestOptions,
	): Promise<AurionAvailablePlanning[]> {
		throwIfAborted(options?.signal);
		const groups = await this.getPlanningsGroups(options);
		const availablePlannings: AurionAvailablePlanning[] = [];
		const subgroupBranches = await Promise.all(groups.map((group) => group.getSubgroups(options)));

		// Independent tree branches carry their own ViewState snapshots. The tree's
		// parent-child dependencies, not an arbitrary worker cap, govern traversal.
		// Planning selection still shares the live JSF chooser state and stays serial.
		for (const subgroup of subgroupBranches.flat()) {
			throwIfAborted(options?.signal);
			availablePlannings.push(...(await subgroup.getPlannings(options)));
		}

		return availablePlannings;
	}

	/**
	 * Alias de {@link getAllAvailablePlannings}.
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns Les plannings sélectionnables sans leurs événements.
	 * @throws {AurionError} Si la récupération des plannings échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async listAvailablePlannings(options?: AurionRequestOptions): Promise<AurionAvailablePlanning[]> {
		return this.getAllAvailablePlannings(options);
	}

	/**
	 * Vide globalement le store de cache configuré.
	 *
	 * Cette opération supprime également les entrées créées par d'autres sessions
	 * qui partagent le même store. Sans store configuré, elle ne fait rien.
	 *
	 * @returns Une promesse résolue lorsque le store a été vidé.
	 */
	async clearCache(): Promise<void> {
		await this.cacheStore?.clear();
	}

	/**
	 * Récupère les sous-groupes feuilles d'un sous-menu de planning.
	 *
	 * @param submenuId Identifiant du sous-menu Aurion à parcourir.
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns Les sous-groupes de planning trouvés sous ce menu.
	 * @throws {AurionError} Si l'authentification, la navigation ou l'analyse échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async getSubgroups(
		submenuId: string,
		options?: AurionRequestOptions,
	): Promise<AurionPlanningSubgroup[]> {
		try {
			await this.transport.login(options?.signal);

			const parentId = this.planningGroupParentIds.get(submenuId);
			const parentSnapshot = parentId ? this.planningGroupSnapshots.get(parentId) : undefined;
			return await this.collectPlanningSubgroups(
				submenuId,
				parentSnapshot,
				new Set<string>(),
				options?.signal,
			);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des sous-groupes de planning Aurion.",
				error,
			);
		}
	}

	/**
	 * Parcourt récursivement les branches d'un sous-menu de plannings.
	 *
	 * @param submenuId Identifiant du sous-menu à parcourir.
	 * @param parentSnapshot Instantané JSF du parent, s'il est déjà disponible.
	 * @param visitedSubmenuIds Identifiants déjà visités pour éviter les cycles.
	 * @param signal Signal d'annulation partagé par l'opération appelante.
	 * @returns Les sous-groupes feuilles trouvés dans l'arbre.
	 */
	private async collectPlanningSubgroups(
		submenuId: string,
		parentSnapshot: MainMenuSnapshot | undefined,
		visitedSubmenuIds: Set<string>,
		signal?: AbortSignal,
	): Promise<AurionPlanningSubgroup[]> {
		if (visitedSubmenuIds.has(submenuId)) {
			return [];
		}

		visitedSubmenuIds.add(submenuId);

		throwIfAborted(signal);
		const snapshot = await this.loadPlanningGroupSubmenu(submenuId, parentSnapshot, signal);
		const children = parseMenuChildren(snapshot.body, submenuId);
		const childBranches = await Promise.all(
			children.map((child) =>
				child.type === "item"
					? Promise.resolve([new AurionPlanningSubgroup(child.name, child.id, this)])
					: this.collectPlanningSubgroups(child.id, snapshot, visitedSubmenuIds, signal),
			),
		);

		return childBranches.flat();
	}

	/**
	 * Liste les plannings sélectionnables d'un menu donné.
	 *
	 * @param menuId Identifiant du menu de planning à ouvrir.
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns Les plannings disponibles dans ce menu.
	 * @throws {AurionError} Si l'authentification, la navigation ou l'analyse échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async getAvailablePlannings(
		menuId: string,
		options?: AurionRequestOptions,
	): Promise<AurionAvailablePlanning[]> {
		try {
			await this.transport.login(options?.signal);

			const snapshot = await this.loadChoixPlanningSnapshot(menuId, false, options?.signal);
			const plannings = parseAvailablePlannings(snapshot.body);

			return plannings.map(
				(planning) => new AurionAvailablePlanning(planning.name, planning.id, menuId, this),
			);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des plannings disponibles Aurion.",
				error,
			);
		}
	}

	/**
	 * Récupère les événements d'un planning sélectionné dans le catalogue de groupes.
	 *
	 * @param menuId Identifiant du menu qui contient le planning.
	 * @param planningId Identifiant du planning à sélectionner.
	 * @param options Fenêtre de dates et options d'annulation facultatives.
	 * @returns Les événements du planning de groupe dans la fenêtre demandée.
	 * @throws {AurionError} Si la navigation ou le parsing des événements échoue.
	 * @throws {RangeError} Si les bornes de dates sont invalides ou mal ordonnées.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
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
			`${this.getSessionCacheScope()}:planningGroup:${menuId}:${planningId}:${serializePlanningWindow(cacheWindow)}`,
		);

		try {
			throwIfAborted(options?.signal);
			const cached =
				await this.readCachedValue<Array<Omit<AurionPlanningEvent, "getDetails">>>(cacheKey);
			if (cached) {
				return filterPlanningEventsByWindow(
					this.attachEventMethods(cached, { menuId, planningId }),
					exactWindow,
				);
			}

			await this.transport.login(options?.signal);

			const planningDate = new Date(cacheWindow.startTimestamp);
			const today = planningDate.toLocaleDateString("fr-FR", {
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
			});
			const week = String(getWeekNumber(planningDate)).padStart(2, "0");
			const year = String(planningDate.getFullYear());

			const planningState = await this.loadPlanningForGroupState(
				menuId,
				planningId,
				options?.signal,
			);
			const response = await this.postPlanning(
				planningState,
				cacheWindow.startTimestamp,
				cacheWindow.endTimestamp,
				today,
				week,
				year,
				options?.signal,
			);

			const planning = parsePlanningEvents(response.body);
			await this.writeCachedValue(cacheKey, planning);

			return filterPlanningEventsByWindow(
				this.attachEventMethods(planning, { menuId, planningId }),
				exactWindow,
			);
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération du planning de groupe Aurion.",
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
	 * @param options Date de référence et signal d'annulation facultatifs.
	 * @returns Les détails complets affichés par Aurion pour cet événement.
	 * @throws {AurionError} Si la navigation, la requête AJAX ou le parsing échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async getEventDetails(
		eventId: string,
		options?: { date?: Date; signal?: AbortSignal },
	): Promise<AurionPlanningEventDetails> {
		const context = this.eventPlanningContexts.get(eventId);
		const resolvePlanningState = context
			? () => this.loadPlanningForGroupState(context.menuId, context.planningId, options?.signal)
			: undefined;
		return this.getEventDetailsWithState(eventId, options, resolvePlanningState);
	}

	/**
	 * Charge et met en cache les détails d'un événement en utilisant l'état fourni.
	 *
	 * @param eventId Identifiant de l'événement Aurion.
	 * @param options Date de référence et signal d'annulation facultatifs.
	 * @param resolvePlanningState Résolveur d'état JSF propre au planning, le cas échéant.
	 * @returns Les informations normalisées de l'événement.
	 * @throws {AurionError} Si la requête, la navigation ou le parsing échoue.
	 */
	private async getEventDetailsWithState(
		eventId: string,
		options?: { date?: Date; signal?: AbortSignal },
		resolvePlanningState?: () => Promise<PlanningNavigationState>,
	): Promise<AurionPlanningEventDetails> {
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:eventDetails:${eventId}`,
		);

		try {
			throwIfAborted(options?.signal);
			const cached = await this.readCachedValue<AurionPlanningEventDetails>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login(options?.signal);

			const response = await this.withNavigationRetry("planningPage", async () => {
				const state = resolvePlanningState
					? await resolvePlanningState()
					: await this.resolvePlanningPageNode(options?.signal);

				return this.postEventDetails(state, eventId, options?.date, options?.signal);
			});

			const details = parseEventDetails(response.body, eventId);
			await this.writeCachedValue(cacheKey, details);

			return details;
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

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
	 * @param options Options de l'appel, dont le signal d'annulation facultatif.
	 * @returns La liste des absences normalisées du compte connecté.
	 * @throws {AurionError} Si l'authentification, la navigation ou le parsing échoue.
	 * @throws {AbortError} Si le signal de cet appel est annulé.
	 */
	async getAbsences(options?: AurionRequestOptions): Promise<AurionAbsence[]> {
		const cacheKey = createAurionValueCacheKey(
			"session",
			`${this.getSessionCacheScope()}:absences`,
		);

		try {
			throwIfAborted(options?.signal);
			const cached = await this.readCachedValue<AurionAbsence[]>(cacheKey);
			if (cached) {
				return cached;
			}

			await this.transport.login(options?.signal);

			const rawAbsences = await this.withNavigationRetry("absencesPage", async () => {
				const state = await this.resolveAbsencesPageNode(options?.signal);

				return this.postAbsencesTable(state, options?.signal);
			});

			const absences = rawAbsences.map((rawAbsence) => toAurionAbsence(rawAbsence));
			await this.writeCachedValue(cacheKey, absences);

			return absences;
		} catch (error: unknown) {
			if (isAurionError(error)) {
				throw error;
			}
			if (isAbortError(error) || options?.signal?.aborted) throw error;

			throw createAurionError(
				"AURION_UNKNOWN_ERROR",
				"Erreur inattendue durant la récupération des absences Aurion.",
				error,
			);
		}
	}

	/**
	 * Initialise la navigation de notes à partir de la page racine Aurion.
	 *
	 * @param state État de navigation à remplir.
	 * @returns Une promesse résolue lorsque l'état racine est prêt.
	 * @throws {AurionError} Si le chargement de la page racine échoue.
	 */
	private async initializeSession(state: GradesNavigationState): Promise<void> {
		await this.initializeRootNavigationState(state, {
			includeFormId: true,
		});
	}

	/**
	 * Renvoie l'instantané de navigation racine ou le reconstruit s'il manque.
	 *
	 * @param options Indique si le formulaire racine est nécessaire et transmet l'annulation.
	 * @returns L'état JSF racine, éventuellement enrichi du formulaire et du HTML.
	 * @throws {AurionError} Si la page racine ou ses identifiants ne peuvent être lus.
	 */
	private async resolveRootNavigationNode(options: {
		includeFormId: boolean;
		signal?: AbortSignal;
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

		await this.initializeRootNavigationState(state, options, options.signal);
		this.writeNavigationNode("root", null, state);

		return state;
	}

	/**
	 * Résout et mémorise l'état du menu Notes à partir de la racine.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF du menu Notes.
	 */
	private async resolveGradesMenuNode(signal?: AbortSignal): Promise<GradesMenuNavigationState> {
		const cached = this.readNavigationNode<GradesMenuNavigationState>("gradesMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: true,
			signal,
		});
		const state: GradesMenuNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			formId: requireRootFormId(root),
			menuId: "",
		};

		await this.postMainMenu(state, signal);
		this.writeNavigationNode("gradesMenu", "root", state);

		return state;
	}

	/**
	 * Résout l'état JSF nécessaire à l'ouverture de la page des notes.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF de la page des notes.
	 */
	private async resolveGradesPageNode(signal?: AbortSignal): Promise<GradesNavigationState> {
		const cached = this.readNavigationNode<GradesNavigationState>("gradesPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolveGradesMenuNode(signal);
		const state: GradesNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			formId: menu.formId,
			menuId: menu.menuId,
			formIdGrade: "",
		};

		await this.postMainSidebar(state, signal);
		this.writeNavigationNode("gradesPage", "gradesMenu", state);

		return state;
	}

	/**
	 * Résout l'état du menu de navigation du planning personnel.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF du menu planning.
	 */
	private async resolvePlanningMenuNode(
		signal?: AbortSignal,
	): Promise<PlanningMenuNavigationState> {
		const cached = this.readNavigationNode<PlanningMenuNavigationState>("planningMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: false,
			signal,
		});
		const state: PlanningMenuNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			menuId: "",
		};

		await this.loadPlanningSidebarMenuId(state, signal);
		this.writeNavigationNode("planningMenu", "root", state);

		return state;
	}

	/**
	 * Résout l'état JSF complet de la page du planning personnel.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF prêt à charger les événements du planning personnel.
	 */
	private async resolvePlanningPageNode(signal?: AbortSignal): Promise<PlanningNavigationState> {
		const cached = this.readNavigationNode<PlanningNavigationState>("planningPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolvePlanningMenuNode(signal);
		const state: PlanningNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			menuId: menu.menuId,
			formIdPlanning: "",
		};

		await this.postSidebarNavigation(state, "getPlanning:postMainSidebar", signal);
		await this.loadPlanningFormState(state, signal);
		this.writeNavigationNode("planningPage", "planningMenu", state);

		return state;
	}

	/**
	 * Résout et mémorise l'état du menu « Mes absences ».
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF du menu des absences.
	 */
	private async resolveAbsencesMenuNode(signal?: AbortSignal): Promise<AbsencesNavigationState> {
		const cached = this.readNavigationNode<AbsencesNavigationState>("absencesMenu");
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: true,
			signal,
		});
		const state: AbsencesNavigationState = {
			viewState: root.viewState,
			idInit: root.idInit,
			formId: requireRootFormId(root),
			menuId: "",
		};

		await this.postAbsencesMainMenu(state, signal);
		this.writeNavigationNode("absencesMenu", "root", state);

		return state;
	}

	/**
	 * Résout l'état JSF nécessaire à la page des absences.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns L'état JSF de la page des absences.
	 */
	private async resolveAbsencesPageNode(signal?: AbortSignal): Promise<AbsencesNavigationState> {
		const cached = this.readNavigationNode<AbsencesNavigationState>("absencesPage");
		if (cached) {
			return cached;
		}

		const menu = await this.resolveAbsencesMenuNode(signal);
		const state: AbsencesNavigationState = {
			viewState: menu.viewState,
			idInit: menu.idInit,
			formId: menu.formId,
			menuId: menu.menuId,
		};

		await this.postSidebarNavigation(state, "getAbsences:postMainSidebar", signal);
		await this.loadAbsencesPageState(state, signal);
		this.writeNavigationNode("absencesPage", "absencesMenu", state);

		return state;
	}

	/**
	 * Ouvre le sous-menu principal qui mène à la zone des notes.
	 *
	 * @param state État de navigation des notes contenant les identifiants JSF actifs.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque l'identifiant de menu latéral est disponible.
	 * @throws {AurionError} Si la navigation JSF du menu principal échoue.
	 */
	private async postMainMenu(
		state: GradesMenuNavigationState,
		signal?: AbortSignal,
	): Promise<void> {
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
			signal,
		});

		assertNavigationSuccess("postMainMenu", response.status, response.url);
		state.menuId = parseMenuId(response.body);
	}

	/**
	 * Navigue vers ChoixIndividu et prépare l'identifiant de table des notes.
	 *
	 * @param state État de navigation des notes à enrichir.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue une fois la page intermédiaire chargée.
	 * @throws {AurionError} Si la navigation vers la page des notes échoue.
	 */
	private async postMainSidebar(state: GradesNavigationState, signal?: AbortSignal): Promise<void> {
		await this.postSidebarNavigation(state, "postMainSidebar:submit", signal);

		const getResponse = await this.transport.request({
			path: "/faces/ChoixIndividu.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/ChoixIndividu.xhtml`,
			},
			cache: false,
			signal,
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
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque le menu planning est identifié.
	 * @throws {AurionError} Si l'écran principal ou le menu planning ne peuvent pas être lus.
	 */
	private async loadPlanningSidebarMenuId(
		state: PlanningMenuNavigationState,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/`,
			},
			cache: false,
			signal,
		});

		assertNavigationSuccess("getPlanning:loadMainMenu", response.status, response.url);
		state.menuId = parseSidebarMenuIdForMonPlanning(response.body);
	}

	/**
	 * Ouvre la page Planning et extrait les identifiants JSF requis pour la requête agenda.
	 *
	 * @param state État de navigation du planning à compléter.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque l'état JSF du planning est prêt.
	 * @throws {AurionError} Si la page Planning ou ses identifiants ne peuvent pas être récupérés.
	 */
	private async loadPlanningFormState(
		state: PlanningNavigationState,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/MainMenuPage.xhtml`,
			},
			cache: false,
			signal,
		});

		assertNavigationSuccess("getPlanning:loadPlanningPage", response.status, response.url);
		state.viewState = parseViewState(response.body);
		state.formIdPlanning = parseFormIdPlanning(response.body);
		state.dateInput = parseInputValue(response.body, "form:date_input");
		state.weekInput = parseInputValue(response.body, "form:week");
	}

	/**
	 * Charge ou réutilise l'instantané JSF d'un sous-menu de planning.
	 *
	 * @param submenuId Identifiant du sous-menu à charger.
	 * @param parentSnapshot Instantané parent utilisé pour conserver le ViewState.
	 * @param signal Signal d'annulation de l'opération appelante.
	 * @returns L'instantané de la réponse, conservé pour la navigation descendante.
	 * @throws {AurionError} Si la requête ou l'analyse de navigation échoue.
	 */
	private async loadPlanningGroupSubmenu(
		submenuId: string,
		parentSnapshot?: MainMenuSnapshot,
		signal?: AbortSignal,
	): Promise<MainMenuSnapshot> {
		const cached = this.planningGroupSnapshots.get(submenuId);
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: true,
			signal,
		});
		const formId = requireRootFormId(root);
		const postData = new URLSearchParams({
			"javax.faces.partial.ajax": "true",
			"javax.faces.source": formId,
			"javax.faces.partial.execute": formId,
			"javax.faces.partial.render": "form:sidebar",
			[formId]: formId,
			"webscolaapp.Sidebar.ID_SUBMENU": submenuId,
			...createMainMenuCommonFields(parentSnapshot?.idInit ?? root.idInit, "1605"),
			...createFormFocusAndInputFields("form:j_idt773_focus", "form:j_idt773_input"),
			"javax.faces.ViewState": parentSnapshot?.viewState ?? root.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/MainMenuPage.xhtml",
			method: "POST",
			body: postData,
			headers: PRIMEFACES_AJAX_HEADERS,
			cache: false,
			signal,
		});

		assertNavigationSuccess("getPlanningsGroups:loadSubmenu", response.status, response.url);

		const snapshot = {
			body: response.body,
			formBody: response.body,
			viewState: parseViewStateOrFallback(
				response.body,
				parentSnapshot?.viewState ?? root.viewState,
			),
			idInit: parentSnapshot?.idInit ?? root.idInit,
		};
		this.planningGroupSnapshots.set(submenuId, snapshot);

		return snapshot;
	}

	/**
	 * Charge ou réutilise l'instantané de la page ChoixPlanning d'un menu.
	 *
	 * @param menuId Identifiant du menu de planning.
	 * @param refresh Force le rechargement même si un instantané est en cache.
	 * @param signal Signal d'annulation de l'opération appelante.
	 * @returns Le corps et les identifiants JSF extraits de la page.
	 * @throws {AurionError} Si la navigation vers la page échoue.
	 */
	private async loadChoixPlanningSnapshot(
		menuId: string,
		refresh = false,
		signal?: AbortSignal,
	): Promise<ChoixPlanningSnapshot> {
		const cached = refresh ? undefined : this.choixPlanningSnapshots.get(menuId);
		if (cached) {
			return cached;
		}

		const root = await this.resolveRootNavigationNode({
			includeFormId: false,
			signal,
		});
		const state = {
			viewState: root.viewState,
			idInit: root.idInit,
			menuId,
		};
		const response = await this.postSidebarNavigation(
			state,
			"getAvailablePlannings:postMainSidebar",
			signal,
		);
		const body = response.body;
		const snapshot = {
			body,
			idInit: parseIdInitOrFallback(body, root.idInit),
			viewState: parseViewStateOrFallback(body, root.viewState),
		};
		this.choixPlanningSnapshots.set(menuId, snapshot);

		return snapshot;
	}

	/**
	 * Sélectionne un planning du catalogue et construit son état JSF actif.
	 *
	 * @param menuId Identifiant du menu contenant le planning.
	 * @param planningId Identifiant du planning à sélectionner.
	 * @param signal Signal d'annulation de l'opération appelante.
	 * @returns L'état JSF prêt à charger les événements du planning.
	 * @throws {AurionError} Si la sélection ou l'analyse de la page échoue.
	 */
	private async loadPlanningForGroupState(
		menuId: string,
		planningId: string,
		signal?: AbortSignal,
	): Promise<PlanningNavigationState> {
		// La navigation de catalogue visite de nombreuses pages JSF : le ViewState
		// d'un ancien ChoixPlanning n'est alors plus valide pour sélectionner un planning.
		const snapshot = await this.loadChoixPlanningSnapshot(menuId, true, signal);
		const tableId = parseChoixPlanningTableId(snapshot.body);
		const submitButtonId = parseChoixPlanningSubmitButtonId(snapshot.body);
		const postData = new URLSearchParams({
			form: "form",
			"form:largeurDivCenter": "1620",
			"form:idInit": snapshot.idInit,
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
			[`${tableId}_reflowDD`]: "0_0",
			[`${tableId}:j_idt186:filter`]: "",
			[`${tableId}:j_idt188:filter`]: "",
			[`${tableId}:j_idt190:filter`]: "",
			[`${tableId}:j_idt192:filter`]: "",
			[`${tableId}_checkbox`]: "on",
			[`${tableId}_selection`]: planningId,
			[submitButtonId]: "",
			"javax.faces.ViewState": snapshot.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/ChoixPlanning.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
			signal,
		});

		assertNavigationSuccess("getPlanningForGroup:selectPlanning", response.status, response.url);

		let planningPageBody = response.body;
		let formIdPlanning = tryParseFormIdPlanning(planningPageBody);
		if (!formIdPlanning) {
			planningPageBody = await this.loadPlanningPageAfterGroupSelection(signal);
			formIdPlanning = parseFormIdPlanning(planningPageBody);
		}

		return {
			viewState: parseViewState(planningPageBody),
			idInit: parseIdInitOrFallback(planningPageBody, snapshot.idInit),
			menuId,
			formIdPlanning,
			dateInput: parseInputValue(planningPageBody, "form:date_input"),
			weekInput: parseInputValue(planningPageBody, "form:week"),
		};
	}

	/**
	 * Charge directement la page Planning après une sélection sans réponse complète.
	 *
	 * @param signal Signal d'annulation de l'opération appelante.
	 * @returns Le HTML de la page planning.
	 * @throws {AurionError} Si la requête de la page échoue.
	 */
	private async loadPlanningPageAfterGroupSelection(signal?: AbortSignal): Promise<string> {
		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/ChoixPlanning.xhtml`,
			},
			cache: false,
			signal,
		});

		assertNavigationSuccess("getPlanningForGroup:loadPlanningPage", response.status, response.url);

		return response.body;
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
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Un objet contenant le corps brut renvoyé par Aurion pour la requête d'agenda.
	 * @throws {AurionError} Si l'appel PrimeFaces du planning échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postPlanning(
		state: PlanningNavigationState,
		startTimestamp: number,
		endTimestamp: number,
		today: string,
		week: string,
		year: string,
		signal?: AbortSignal,
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
			"javax.faces.ViewState": state.viewState,
		});

		const response = await this.transport.request({
			path: "/faces/Planning.xhtml",
			method: "POST",
			body: postData,
			headers: FORM_URLENCODED_HEADERS,
			cache: false,
			signal,
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
	 * @param date Date de référence utilisée pour les paramètres du calendrier.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Un objet contenant le corps XML partiel renvoyé par Aurion.
	 * @throws {AurionError} Si l'appel PrimeFaces échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postEventDetails(
		state: PlanningNavigationState,
		eventId: string,
		date?: Date,
		signal?: AbortSignal,
	): Promise<{ body: string }> {
		const sourceId = state.formIdPlanning;
		const fallbackDate = date ?? new Date();
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
			signal,
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
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque l'entrée « Mes absences » est ciblée.
	 * @throws {AurionError} Si la navigation JSF du menu principal échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postAbsencesMainMenu(
		state: AbsencesNavigationState,
		signal?: AbortSignal,
	): Promise<void> {
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
			signal,
		});

		assertNavigationSuccess("getAbsences:postMainMenu", response.status, response.url);
		state.menuId = parseMenuId(response.body, "Mes absences</span>");
	}

	/**
	 * Charge la page MesAbsences et met à jour les champs de contexte JSF actifs.
	 *
	 * @param state État de navigation des absences à mettre à jour.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque la page des absences est chargée.
	 * @throws {AurionError} Si la page MesAbsences ou ses identifiants ne peuvent pas être récupérés.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async loadAbsencesPageState(
		state: AbsencesNavigationState,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.transport.request({
			path: "/faces/MesAbsences.xhtml",
			method: "GET",
			headers: {
				Referer: `${this.baseUrl}/faces/MesAbsences.xhtml`,
			},
			cache: false,
			signal,
		});

		assertNavigationSuccess("getAbsences:loadMesAbsences", response.status, response.url);

		state.viewState = parseViewState(response.body);
		state.idInit = parseIdInit(response.body);
	}

	/**
	 * Exécute la requête de pagination de la table d'absences et parse les lignes HTML.
	 *
	 * @param state État de navigation des absences contenant le contexte JSF actif.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Les lignes brutes d'absences extraites de la réponse HTML.
	 * @throws {AurionError} Si la requête ou le parsing de la table échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postAbsencesTable(
		state: AbsencesNavigationState,
		signal?: AbortSignal,
	): Promise<RawAurionAbsenceRow[]> {
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
			signal,
		});

		assertNavigationSuccess("getAbsences:postAbsences", response.status, response.url);

		return parseAbsences(response.body);
	}

	/**
	 * Déclenche la requête PrimeFaces qui renvoie les lignes de notes.
	 *
	 * @param state État de navigation des notes contenant l'identifiant de table.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Les lignes brutes de notes renvoyées par Aurion.
	 * @throws {AurionError} Si la requête ou le parsing des notes échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postGrade(
		state: GradesNavigationState,
		signal?: AbortSignal,
	): Promise<RawAurionGradeRow[]> {
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
			signal,
		});

		assertNavigationSuccess("postGrade", response.status, response.url);

		return parseGrades(response.body);
	}

	/**
	 * Initialise les identifiants de navigation communs depuis la racine Aurion.
	 *
	 * @param state Structure d'état à peupler avec les identifiants racine.
	 * @param options Indique notamment s'il faut extraire aussi l'identifiant de formulaire.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque l'état racine est initialisé.
	 * @throws {AurionError} Si la page racine ou ses identifiants JSF sont indisponibles.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async initializeRootNavigationState(
		state: { viewState: string; idInit: string; formId?: string; body?: string },
		options: { includeFormId: boolean },
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.transport.request({
			path: "/",
			method: "GET",
			cache: false,
			signal,
		});

		assertNavigationSuccess("initializeSession", response.status, response.url);

		state.viewState = parseViewState(response.body);
		state.idInit = parseIdInit(response.body);
		state.body = response.body;

		if (options.includeFormId) {
			state.formId = parseFormId(response.body);
		}
	}

	/**
	 * Soumet une navigation latérale sur MainMenuPage à partir d'un `menuId` déjà résolu.
	 *
	 * @param state État de navigation contenant `viewState`, `idInit` et `menuId`.
	 * @param step Nom logique de l'étape de navigation pour le reporting d'erreur.
	 * @param signal Signal d'annulation facultatif de l'opération appelante.
	 * @returns Une promesse résolue lorsque la soumission latérale a abouti.
	 * @throws {AurionError} Si la navigation latérale échoue.
	 * @throws {AbortError} Si le signal de l'opération est annulé.
	 */
	private async postSidebarNavigation(
		state: { viewState: string; idInit: string; menuId: string },
		step: string,
		signal?: AbortSignal,
	): Promise<{ body: string }> {
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
			signal,
		});

		assertNavigationSuccess(step, response.status, response.url);

		return {
			body: response.body,
		};
	}

	/**
	 * Réessaie une navigation une fois après invalidation d'un état JSF périmé.
	 *
	 * @param nodeId Nœud de navigation à invalider après un échec récupérable.
	 * @param action Opération de navigation à exécuter puis éventuellement rejouer.
	 * @returns La valeur renvoyée par l'opération réussie.
	 * @throws {AurionError} Si l'échec n'est pas récupérable ou persiste après réessai.
	 */
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

	/** Lit l'état de navigation mémorisé pour un nœud, s'il existe. */
	private readNavigationNode<TState>(id: AurionNavigationNodeId): TState | null {
		const node = this.navigationNodes.get(id);
		if (!node) {
			return null;
		}

		return node.state as TState;
	}

	/** Mémorise un état et le lien de dépendance avec son nœud parent. */
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

	/** Invalide un nœud ainsi que tous ses descendants dépendants. */
	private invalidateNavigationNode(id: AurionNavigationNodeId): void {
		this.navigationNodes.delete(id);

		for (const node of Array.from(this.navigationNodes.values())) {
			if (node.parentId === id) {
				this.invalidateNavigationNode(node.id);
			}
		}
	}

	/** Lit une valeur du cache de session et supprime toute entrée expirée. */
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

	/** Écrit une valeur normalisée dans le store configuré, si disponible. */
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

	/** Construit l'espace de clés isolant l'URL Aurion et le compte courant. */
	private getSessionCacheScope(): string {
		return `${this.baseUrl}:${this.username}`;
	}

	/** Ajoute à chaque événement la méthode permettant de charger ses détails. */
	private attachEventMethods(
		events: Array<Omit<AurionPlanningEvent, "getDetails">>,
		groupContext?: { menuId: string; planningId: string },
	): AurionPlanningEvent[] {
		return events.map((event) => {
			if (groupContext) {
				this.eventPlanningContexts.set(event.id, groupContext);
			}

			return {
				...event,
				getDetails: (options) => {
					const resolvePlanningState = groupContext
						? () =>
								this.loadPlanningForGroupState(
									groupContext.menuId,
									groupContext.planningId,
									options?.signal,
								)
						: undefined;
					return this.getEventDetailsWithState(
						event.id,
						{ date: event.start, signal: options?.signal },
						resolvePlanningState,
					);
				},
			};
		});
	}
}

/** État intermédiaire propagé entre les étapes de navigation Aurion. */
interface RootNavigationState {
	/** Valeur JSF ViewState de la page racine. */
	viewState: string;
	/** Identifiant de contexte racine utilisé dans les formulaires. */
	idInit: string;
	/** Identifiant du formulaire racine, s'il a été extrait. */
	formId?: string;
	/** Réponse HTML initiale, si la navigation en a besoin. */
	body?: string;
}

interface MainMenuSnapshot {
	/** Corps de la réponse du sous-menu ouvert. */
	body: string;
	/** Copie du corps servant de contexte au formulaire parent. */
	formBody: string;
	/** ViewState actif après l'ouverture du sous-menu. */
	viewState: string;
	/** Identifiant racine associé au formulaire du menu. */
	idInit: string;
}

interface ChoixPlanningSnapshot {
	/** Corps HTML de la page de sélection des plannings. */
	body: string;
	/** Identifiant racine extrait ou repris du contexte précédent. */
	idInit: string;
	/** ViewState requis pour la soumission suivante. */
	viewState: string;
}

/** État du menu Notes résolu depuis la racine de session. */
interface GradesMenuNavigationState {
	/** ViewState de la page du menu Notes. */
	viewState: string;
	/** Identifiant du formulaire racine. */
	formId: string;
	/** Identifiant du menu Notes sélectionné. */
	menuId: string;
	/** Identifiant de contexte de la page. */
	idInit: string;
}

/** État du menu Planning résolu depuis la racine de session. */
interface PlanningMenuNavigationState {
	/** ViewState de la page du menu principal. */
	viewState: string;
	/** Identifiant du menu Planning. */
	menuId: string;
	/** Identifiant de contexte de la page. */
	idInit: string;
}

interface GradesNavigationState {
	/** ViewState courant de la navigation Notes. */
	viewState: string;
	/** Identifiant du formulaire racine. */
	formId: string;
	/** Identifiant du menu actuellement sélectionné. */
	menuId: string;
	/** Identifiant de contexte de la page. */
	idInit: string;
	/** Identifiant du formulaire de la table des notes. */
	formIdGrade: string;
}

/** État intermédiaire utilisé pendant la navigation de la section planning. */
interface PlanningNavigationState {
	/** ViewState courant de la page Planning. */
	viewState: string;
	/** Identifiant du menu Planning ouvert. */
	menuId: string;
	/** Identifiant de contexte de la page. */
	idInit: string;
	/** Identifiant du formulaire calendrier. */
	formIdPlanning: string;
	/** Date formatée conservée par le formulaire Aurion. */
	dateInput?: string | null;
	/** Semaine formatée conservée par le formulaire Aurion. */
	weekInput?: string | null;
}

/** État intermédiaire utilisé pendant la navigation de la section absences. */
interface AbsencesNavigationState {
	/** ViewState courant de la page des absences. */
	viewState: string;
	/** Identifiant du formulaire racine. */
	formId: string;
	/** Identifiant du menu des absences. */
	menuId: string;
	/** Identifiant de contexte de la page. */
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
	/** Identifiant stable du nœud de navigation. */
	id: AurionNavigationNodeId;
	/** Nœud dont dépend cet état, ou `null` pour la racine. */
	parentId: AurionNavigationNodeId | null;
	/** Instant de création de l'instantané, en millisecondes Unix. */
	createdAt: number;
	/** Données de navigation associées au nœud. */
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

/**
 * Exige la présence de l'identifiant de formulaire dans l'état racine.
 * @param state État racine dont le formulaire est requis.
 * @returns L'identifiant de formulaire racine.
 * @throws {AurionError} Si l'état ne contient pas cet identifiant.
 */
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

/**
 * Exige la présence du corps HTML initial dans l'état racine.
 * @param state État racine dont le corps HTML est requis.
 * @returns Le corps HTML de la réponse racine.
 * @throws {AurionError} Si l'état ne contient pas ce corps.
 */
function requireRootBody(state: RootNavigationState): string {
	if (state.body) {
		return state.body;
	}

	throw createAurionError("AURION_NAVIGATION_ERROR", "Corps HTML racine Aurion indisponible.", {
		parser: "requireRootBody",
	});
}

/**
 * Tente de trouver l'identifiant d'un sous-menu, sans propager les erreurs de parsing.
 * @param body Réponse HTML contenant le menu.
 * @param keyword Texte visible associé au sous-menu.
 * @returns L'identifiant trouvé, ou `null` si le menu n'est pas présent ou lisible.
 * @throws {AurionError} Si une erreur autre qu'une erreur de parsing survient.
 */
function tryParseSubmenuId(body: string, keyword: string): string | null {
	try {
		return parseSubmenuId(body, keyword);
	} catch (error: unknown) {
		if (isAurionError(error) && error.code === "AURION_PARSING_ERROR") {
			return null;
		}

		throw error;
	}
}

/**
 * Extrait le ViewState d'une réponse partielle ou utilise la valeur précédente.
 * @param body Corps de la réponse HTML ou XML.
 * @param fallback ViewState à conserver lorsque la réponse n'en fournit pas.
 * @returns Le ViewState extrait ou la valeur de repli.
 */
function parseViewStateOrFallback(body: string, fallback: string): string {
	const partialResponseViewState = body.match(
		/<update\b[^>]*id=["'][^"']*javax\.faces\.ViewState(?::\d+)?["'][^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/update>/i,
	);
	if (partialResponseViewState?.[1]) {
		return partialResponseViewState[1];
	}

	try {
		return parseViewState(body);
	} catch (error: unknown) {
		if (isAurionError(error)) {
			return fallback;
		}

		throw error;
	}
}

/**
 * Extrait `idInit` de la réponse, ou conserve l'identifiant précédent.
 * @param body Corps HTML à analyser.
 * @param fallback Identifiant de repli si l'extraction échoue.
 * @returns L'identifiant extrait ou la valeur de repli.
 */
function parseIdInitOrFallback(body: string, fallback: string): string {
	try {
		return parseIdInit(body);
	} catch (error: unknown) {
		if (isAurionError(error)) {
			return fallback;
		}

		throw error;
	}
}

/**
 * Tente d'extraire l'identifiant du formulaire Planning.
 * @param body Corps HTML ou XML à analyser.
 * @returns L'identifiant trouvé, ou `null` si la réponse ne le contient pas.
 * @throws {AurionError} Si l'extraction échoue pour une raison autre que le parsing.
 */
function tryParseFormIdPlanning(body: string): string | null {
	try {
		return parseFormIdPlanning(body);
	} catch (error: unknown) {
		if (isAurionError(error) && error.code === "AURION_PARSING_ERROR") {
			return null;
		}

		throw error;
	}
}

/**
 * Repère l'identifiant de la table de sélection des plannings.
 * @param body Corps HTML de ChoixPlanning.
 * @returns L'identifiant JSF de la table.
 * @throws {AurionError} Si aucun marqueur de table reconnu n'est trouvé.
 */
function parseChoixPlanningTableId(body: string): string {
	const selectionMatch =
		body.match(/\bname=["'](form:[^"']+)_selection["']/i) ??
		body.match(/\bid=["'](form:[^"']+)_selection["']/i) ??
		body.match(/\bname=["'](form:[^"']+)_checkbox["']/i) ??
		body.match(/\bid=["'](form:[^"']+)_checkbox["']/i) ??
		body.match(/\bname=["'](form:[^"']+)_reflowDD["']/i) ??
		body.match(/\bid=["'](form:[^"']+)_reflowDD["']/i);

	if (selectionMatch?.[1]) {
		return selectionMatch[1];
	}

	throw createAurionError(
		"AURION_PARSING_ERROR",
		"Identifiant de table ChoixPlanning Aurion introuvable.",
		{
			parser: "parseChoixPlanningTableId",
		},
	);
}

/**
 * Repère le bouton de soumission « Voir planning » dans la page de sélection.
 * @param body Corps HTML de ChoixPlanning.
 * @returns Le nom ou l'identifiant du bouton de soumission.
 * @throws {AurionError} Si le bouton ou son identifiant est absent.
 */
function parseChoixPlanningSubmitButtonId(body: string): string {
	for (const button of body.matchAll(/<button\b[\s\S]*?<\/button>/gi)) {
		const markup = button[0];
		if (!markup.includes("Voir planning")) {
			continue;
		}

		const id =
			markup.match(/\bname=["']([^"']+)["']/i)?.[1] ?? markup.match(/\bid=["']([^"']+)["']/i)?.[1];
		if (id) {
			return id;
		}
	}

	throw createAurionError(
		"AURION_PARSING_ERROR",
		"Bouton Voir planning ChoixPlanning Aurion introuvable.",
		{
			parser: "parseChoixPlanningSubmitButtonId",
		},
	);
}

/** Indique si un code d'erreur justifie de reconstruire l'état de navigation. */
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

/**
 * Extrait la valeur d'un champ HTML identifié par son attribut `name`.
 * @param body Corps HTML de la page.
 * @param name Nom du champ à rechercher.
 * @returns Sa valeur, ou `null` si aucun champ correspondant n'existe.
 */
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
	if (endTimestamp <= startTimestamp) {
		throw new RangeError("Aurion planning end must be later than start.");
	}

	return {
		startTimestamp,
		endTimestamp,
	};
}

/** Détermine si une valeur d'erreur porte le nom standard `AbortError`. */
function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
	);
}

/** Interrompt immédiatement l'opération si son signal est déjà annulé. */
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
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

/**
 * Élargit une fenêtre afin qu'elle corresponde aux bornes d'approximation du cache.
 * @param window Fenêtre exacte exprimée en timestamps Unix en millisecondes.
 * @param approximationMs Taille facultative du compartiment d'approximation.
 * @returns La fenêtre arrondie, ou la fenêtre originale si l'approximation est désactivée.
 */
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

/** Sérialise les bornes d'une fenêtre pour les intégrer à une clé de cache. */
function serializePlanningWindow(window: { startTimestamp: number; endTimestamp: number }): string {
	const start = new Date(window.startTimestamp).toISOString();
	const end = new Date(window.endTimestamp).toISOString();

	return `${start}:${end}`;
}

/**
 * Conserve les événements dont la durée chevauche la fenêtre demandée.
 * @param events Événements à filtrer.
 * @param window Fenêtre exacte en timestamps Unix en millisecondes.
 * @returns Les événements qui chevauchent au moins une partie de la fenêtre.
 */
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
