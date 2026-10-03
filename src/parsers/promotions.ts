import { normalizeText, throwParsingError } from "./shared";

/** Représente une entrée enfant du menu de promotions, sous-menu ou élément navigable. */
export interface PromotionMenuEntry {
	type: "submenu" | "item";
	id: string;
	name: string;
	isLoaded?: boolean;
}

/**
 * Résout l'identifiant de sous-menu PrimeFaces associé à un libellé visible.
 *
 * @param body HTML du menu Aurion à parcourir.
 * @param keyword Libellé du lien recherché, comparé après normalisation du texte.
 * @returns Identifiant du sous-menu associé au lien trouvé.
 * @throws {AurionError} Si le libellé ou un identifiant de sous-menu correspondant est introuvable.
 */
export function parseSubmenuId(body: string, keyword: string): string {
	const normalizedKeyword = normalizeText(keyword);
	const anchors = Array.from(body.matchAll(/<a\b[\s\S]*?<\/a>/gi));

	for (const anchor of anchors) {
		const markup = anchor[0];
		if (normalizeText(markup) !== normalizedKeyword) {
			continue;
		}

		const ancestorListItem = extractAncestorListItem(body, anchor.index ?? 0);
		const id = extractSubmenuId(markup) ?? extractSubmenuId(ancestorListItem ?? "");
		if (id) {
			return id;
		}
	}

	const keywordIndex = normalizeText(body).indexOf(normalizedKeyword);
	if (keywordIndex !== -1) {
		const rawIndex = body.indexOf(keyword);
		const snippetStart = rawIndex === -1 ? 0 : Math.max(0, rawIndex - 600);
		const snippet = body.slice(
			snippetStart,
			rawIndex === -1 ? undefined : rawIndex + keyword.length + 600,
		);
		const id = extractSubmenuId(snippet);
		if (id) {
			return id;
		}
	}

	throwParsingError(body, "parseSubmenuId", "Submenu id not found", {
		keyword,
	});
}

/**
 * Extrait les liens enfants directs d'un nœud de menu Aurion et déduplique les identifiants.
 *
 * @param body HTML complet du menu.
 * @param parentSubmenuId Identifiant du sous-menu dont les enfants sont demandés.
 * @returns Entrées trouvées, avec leur type, identifiant, libellé et état de chargement éventuel.
 */
export function parseMenuChildren(body: string, parentSubmenuId: string): PromotionMenuEntry[] {
	const scope = extractSubmenuScope(body, parentSubmenuId) ?? body;
	const entries = new Map<string, PromotionMenuEntry>();

	for (const anchor of scope.matchAll(/<a\b[\s\S]*?<\/a>/gi)) {
		const markup = anchor[0];
		const name = normalizeText(markup);
		if (!name) {
			continue;
		}

		const ancestorListItem = extractAncestorListItem(scope, anchor.index ?? 0);
		const submenuId = extractSubmenuId(markup) ?? extractSubmenuId(ancestorListItem ?? "");
		if (submenuId && submenuId !== parentSubmenuId) {
			entries.set(`submenu:${submenuId}`, {
				type: "submenu",
				id: submenuId,
				name,
				isLoaded: scope.includes(`id="${submenuId}"`) || scope.includes(`id='${submenuId}'`),
			});
			continue;
		}

		const menuId = extractSidebarMenuId(markup);
		if (menuId) {
			entries.set(`item:${menuId}`, {
				type: "item",
				id: menuId,
				name,
			});
		}
	}

	return Array.from(entries.values());
}

/**
 * Extrait les plannings sélectionnables du tableau de la page `ChoixPlanning`.
 *
 * @param body HTML de la page contenant les lignes de plannings.
 * @returns Paires identifiant/libellé des plannings pour lesquels les deux valeurs sont disponibles.
 */
export function parseAvailablePlannings(body: string): { id: string; name: string }[] {
	const rows = body.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
	const plannings = new Map<string, string>();

	for (const row of rows) {
		const id =
			row.match(/\bdata-rk=["']([^"']+)["']/i)?.[1] ??
			row.match(
				/\bvalue=["'](\d+)["'][^>]*(?:name|id)=["'][^"']*(?:selection|checkbox)[^"']*["']/i,
			)?.[1] ??
			row.match(
				/\b(?:name|id)=["'][^"']*(?:selection|checkbox)[^"']*["'][^>]*\bvalue=["'](\d+)["']/i,
			)?.[1];
		if (!id) {
			continue;
		}

		const cells = Array.from(row.matchAll(/<t[dh]\b[\s\S]*?>([\s\S]*?)<\/t[dh]>/gi))
			.map((cell) => normalizeText(cell[1] ?? ""))
			.filter((cell) => cell !== "" && cell !== "on");
		// ChoixPlanning affiche code, libellé, validité et type : le nom humain
		// est le deuxième contenu de cellule, pas le dernier (ex. "Planning").
		const name = cells.length > 2 ? cells[1] : (cells.at(-1) ?? normalizeText(row));
		if (name) {
			plannings.set(id, name);
		}
	}

	return Array.from(plannings, ([id, name]) => ({ id, name }));
}

/** Localise le bloc `<li>` correspondant au sous-menu parent, s'il existe.
 * @param body HTML du menu.
 * @param parentSubmenuId Identifiant ou classe permettant de repérer le bloc.
 * @returns Le bloc équilibré, ou `null` si le nœud n'est pas trouvé.
 */
function extractSubmenuScope(body: string, parentSubmenuId: string): string | null {
	const escaped = escapeRegExp(parentSubmenuId);
	const tagMatch = body.match(
		new RegExp(
			`<li\\b(?=[^>]*(?:id=["']${escaped}["']|class=["'][^"']*\\b${escaped}\\b))[^>]*>`,
			"i",
		),
	);
	if (!tagMatch?.[0] || tagMatch.index === undefined) {
		return null;
	}

	return extractBalancedElement(body.slice(tagMatch.index), "li");
}

/** Retrouve le bloc de liste `<li>` englobant une position dans le HTML.
 * @param body Fragment HTML.
 * @param childIndex Position du lien enfant dans ce fragment.
 * @returns Le bloc équilibré trouvé, ou `null` en l'absence d'ancêtre repérable.
 */
function extractAncestorListItem(body: string, childIndex: number): string | null {
	const listItemStart = body.lastIndexOf("<li", childIndex);
	if (listItemStart === -1) {
		return null;
	}

	return extractBalancedElement(body.slice(listItemStart), "li");
}

/** Extrait le premier élément complet du type demandé en comptant ses balises imbriquées.
 * @param markup HTML à parcourir à partir de l'ouverture potentielle.
 * @param tagName Nom de la balise sans chevrons.
 * @returns Le fragment équilibré, ou `null` si sa fermeture manque.
 */
function extractBalancedElement(markup: string, tagName: string): string | null {
	const pattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
	let depth = 0;
	let start: number | null = null;

	for (const match of markup.matchAll(pattern)) {
		const token = match[0];
		const index = match.index ?? 0;
		if (!token.startsWith("</")) {
			if (depth === 0) {
				start = index;
			}
			depth += 1;
			continue;
		}

		depth -= 1;
		if (depth === 0 && start !== null) {
			return markup.slice(start, index + token.length);
		}
	}

	return null;
}

/** Cherche un identifiant de sous-menu dans les formes de paramètres PrimeFaces connues.
 * @param markup HTML ou code JavaScript associé au lien.
 * @returns Identifiant extrait, ou `null` si aucune forme reconnue n'apparaît.
 */
function extractSubmenuId(markup: string): string | null {
	return (
		markup.match(/webscolaapp\.Sidebar\.ID_SUBMENU["']?\s*[:=]\s*["']([^"'&]+)["']/i)?.[1] ??
		markup.match(/ID_SUBMENU["']?\s*,\s*["']([^"']+)["']/i)?.[1] ??
		markup.match(/ID_SUBMENU=([^&"'\s)]+)/i)?.[1] ??
		markup.match(/\b(submenu_\d+)\b/i)?.[1] ??
		null
	);
}

/** Extrait l'identifiant d'élément transmis par le paramètre `form:sidebar_menuid`.
 * @param markup HTML ou code JavaScript associé au lien.
 * @returns Identifiant extrait, ou `null` s'il est absent.
 */
function extractSidebarMenuId(markup: string): string | null {
	return (
		markup.match(/form:sidebar_menuid["']?\s*:\s*["']([^"']+)["']/i)?.[1] ??
		markup.match(/form:sidebar_menuid=([^&"'\s)]+)/i)?.[1] ??
		null
	);
}

/** Échappe les métacaractères afin d'insérer une valeur littérale dans une expression régulière.
 * @param value Texte à échapper.
 * @returns Texte utilisable comme motif littéral.
 */
function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
