import { normalizeText, throwParsingError } from "./shared";

export interface PromotionMenuEntry {
	type: "submenu" | "item";
	id: string;
	name: string;
	isLoaded?: boolean;
}

/**
 * Résout l'identifiant `submenu_XXXXX` associé à un mot-clé de menu.
 *
 * @param body Corps HTML contenant le menu Aurion.
 * @param keyword Libellé exact recherché dans le menu.
 * @returns L'identifiant PrimeFaces du sous-menu correspondant.
 * @throws {AurionError} Si aucun sous-menu correspondant n'est trouvé.
 */
export function parseSubmenuId(body: string, keyword: string): string {
	const escapedKeyword = escapeRegExp(keyword);

	// Format 1: Look for <li ... submenu_XXXXX ...>
	// and then look for the keyword in a span shortly after.
	const liRegex = new RegExp(
		`<li[^>]*submenu_(\\d+)[^>]*>([\\s\\S]{0,500}?)<span[^>]*>${escapedKeyword}<\\/span>`,
		"i",
	);
	const liMatch = body.match(liRegex);
	if (liMatch?.[1] && liMatch[2]) {
		// Ensure we didn't cross another <li>
		if (!liMatch[2].includes("<li")) {
			return `submenu_${liMatch[1]}`;
		}
	}

	// Format 2: Look for 'webscolaapp.Sidebar.ID_SUBMENU' value
	const unescapedBody = body.replace(/&quot;/g, '"');
	const aRegex = new RegExp(
		`(?:value:"|'webscolaapp\\.Sidebar\\.ID_SUBMENU':')(submenu_\\d+)["']([\\s\\S]{0,500}?)<span[^>]*>${escapedKeyword}<\\/span>`,
		"i",
	);
	const aMatch = unescapedBody.match(aRegex);
	if (aMatch?.[1] && aMatch[2]) {
		if (!aMatch[2].includes("<a")) {
			return aMatch[1];
		}
	}

	// Fallback: just search for the ID right before the keyword span
	const fallbackRegex = new RegExp(
		`(submenu_\\d+)[\\s\\S]{0,200}?<span[^>]*>${escapedKeyword}<\\/span>`,
		"i",
	);
	const fallbackMatch = unescapedBody.match(fallbackRegex);
	if (fallbackMatch?.[1]) {
		return fallbackMatch[1];
	}

	throwParsingError(body, "parseSubmenuId", "Menu submenu id not found", {
		keyword,
	});
}

/**
 * Parse les enfants directs d'un sous-menu Aurion.
 *
 * @param body Corps HTML contenant l'arborescence de menu.
 * @param parentSubmenuId Identifiant `submenu_XXXXX` du parent.
 * @returns Les enfants directs du sous-menu parent.
 * @throws {AurionError} Si le sous-menu parent ne peut pas être localisé ou si sa structure est incohérente.
 */
export function parseMenuChildren(body: string, parentSubmenuId: string): PromotionMenuEntry[] {
	const parentTagMatch = body.match(
		new RegExp(`<li[^>]*\\b${escapeRegExp(parentSubmenuId)}\\b[^>]*>`),
	);
	if (!parentTagMatch?.[0]) {
		throwParsingError(body, "parseMenuChildren", "Parent submenu id not found", {
			parentSubmenuId,
		});
	}

	const parentLiStart = body.indexOf(parentTagMatch[0]);
	if (parentLiStart === -1) {
		throwParsingError(body, "parseMenuChildren", "Parent submenu opening tag not found", {
			parentSubmenuId,
		});
	}

	const parentLiEnd = findTagEnd(body, parentLiStart, "li");
	if (parentLiEnd === -1) {
		throwParsingError(body, "parseMenuChildren", "Parent submenu opening tag is incomplete", {
			parentSubmenuId,
		});
	}

	const ulStart = body.indexOf("<ul", parentLiEnd);
	if (ulStart === -1) {
		throwParsingError(body, "parseMenuChildren", "Parent submenu <ul> block not found", {
			parentSubmenuId,
		});
	}

	const ulEnd = findMatchingTagEnd(body, ulStart, "ul");
	if (ulEnd === -1) {
		throwParsingError(body, "parseMenuChildren", "Parent submenu <ul> block is incomplete", {
			parentSubmenuId,
		});
	}

	const childrenBlock = body.slice(ulStart, ulEnd);
	const childLis = extractDirectChildBlocks(childrenBlock, "li");

	return childLis
		.map((child) => parseMenuChild(child.block))
		.filter((child): child is PromotionMenuEntry => child !== null);
}

/**
 * Parse les plannings disponibles depuis la table `ChoixPlanning.xhtml`.
 *
 * @param body Corps HTML de la page de sélection des plannings.
 * @returns Les identifiants et libellés des plannings disponibles.
 * @throws {AurionError} Si la table ne contient aucune ligne exploitable.
 */
export function parseAvailablePlannings(body: string): Array<{
	id: string;
	name: string;
	code: string;
	label: string;
	validityEnd: string;
	kind: string;
}> {
	const rows = Array.from(body.matchAll(/<tr[^>]*data-rk="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g));
	if (rows.length === 0) {
		throwParsingError(body, "parseAvailablePlannings", "Planning selection table rows not found");
	}

	const plannings = rows
		.map((row) => {
			const id = row[1]?.trim() ?? "";
			const rowBody = row[2] ?? "";
			const cells = Array.from(rowBody.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), (match) =>
				normalizeText(match[1] ?? ""),
			);
			const [selection = "", code = "", label = "", validityEnd = "", kind = ""] = cells;
			void selection;
			const name = label;

			return { id, name, code, label, validityEnd, kind };
		})
		.filter(
			(planning) => planning.id.length > 0 && planning.code.length > 0 && planning.label.length > 0,
		);

	if (plannings.length === 0) {
		throwParsingError(
			body,
			"parseAvailablePlannings",
			"No planning rows with extractable identifiers were found",
		);
	}

	return plannings;
}

/**
 * Analyse un bloc HTML enfant pour déterminer s'il s'agit d'un sous-menu ou d'un élément cliquable.
 *
 * @param childBlock Fragment HTML représentant l'enfant direct (typiquement un `<li>`).
 * @returns Une représentation `PromotionMenuEntry` de l'enfant, ou `null` si non reconnu.
 */
function parseMenuChild(childBlock: string): PromotionMenuEntry | null {
	const submenuMatch = childBlock.match(/\bsubmenu_(\d+)\b/);
	if (submenuMatch?.[1]) {
		const name = extractMenuName(childBlock);
		if (!name) {
			throwParsingError(childBlock, "parseMenuChildren", "Submenu child name not found", {
				childSnippet: childBlock.slice(0, 280),
			});
		}

		return {
			type: "submenu",
			id: `submenu_${submenuMatch[1]}`,
			name,
			isLoaded: /enfants-entierement-charges/.test(childBlock) ? true : undefined,
		};
	}

	const itemMatch = childBlock.match(/form:sidebar_menuid['"]?\s*:\s*['"]([^'"]+)['"]/);
	if (itemMatch?.[1]) {
		const name = extractMenuName(childBlock);
		if (!name) {
			throwParsingError(childBlock, "parseMenuChildren", "Menu item name not found", {
				childSnippet: childBlock.slice(0, 280),
			});
		}

		return {
			type: "item",
			id: itemMatch[1],
			name,
		};
	}

	return null;
}

/**
 * Extrait le libellé textuel d'un élément de menu Aurion en ignorant les balises d'icônes.
 *
 * @param html Fragment HTML de l'élément de menu.
 * @returns Le texte visible du menu.
 */
function extractMenuName(html: string): string {
	const spans = Array.from(html.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g), (match) =>
		normalizeText(match[1] ?? ""),
	);

	return spans.reverse().find((text) => text.length > 0) ?? "";
}

/**
 * Extrait tous les blocs HTML correspondants à une balise donnée, situés au premier niveau de profondeur.
 *
 * Cette fonction est utile pour extraire les enfants directs (ex: `<li>`) d'un parent
 * sans capturer les `<li>` imbriqués plus profondément.
 *
 * @param body Le fragment HTML contenant les éléments.
 * @param tagName Le nom de la balise cible (ex: `"li"`).
 * @returns Un tableau d'objets contenant le bloc HTML complet et ses positions de début et de fin.
 */
function extractDirectChildBlocks(
	body: string,
	tagName: string,
): Array<{ block: string; start: number; end: number }> {
	const openingTag = new RegExp(`<${tagName}\\b`, "gi");
	const closingTag = new RegExp(`</${tagName}\\s*>`, "gi");
	const matches: Array<{ index: number; type: "open" | "close"; end: number }> = [];

	for (const match of body.matchAll(openingTag)) {
		if (typeof match.index === "number") {
			matches.push({ index: match.index, type: "open", end: match.index + match[0].length });
		}
	}

	for (const match of body.matchAll(closingTag)) {
		if (typeof match.index === "number") {
			matches.push({ index: match.index, type: "close", end: match.index + match[0].length });
		}
	}

	matches.sort((left, right) => left.index - right.index || (left.type === "close" ? 1 : -1));

	const blocks: Array<{ block: string; start: number; end: number }> = [];
	let depth = 0;
	let currentStart = -1;

	for (const match of matches) {
		if (match.type === "open") {
			if (depth === 0) {
				currentStart = match.index;
			}
			depth += 1;
			continue;
		}

		if (depth === 0) {
			continue;
		}

		depth -= 1;
		if (depth === 0 && currentStart !== -1) {
			blocks.push({
				block: body.slice(currentStart, match.end),
				start: currentStart,
				end: match.end,
			});
			currentStart = -1;
		}
	}

	return blocks;
}

/**
 * Trouve l'index de la fin de la balise ouvrante (le caractère `>`) en gérant correctement
 * les guillemets pour éviter les faux positifs (ex: `>` à l'intérieur d'un attribut).
 *
 * @param body Le document HTML.
 * @param startIndex L'index de début de la balise (le `<`).
 * @param tagName Le nom de la balise (ex: `"li"`).
 * @returns L'index du chevron fermant `>`, ou `-1` si non trouvé.
 */
function findTagEnd(body: string, startIndex: number, tagName: string): number {
	const openPrefix = `<${tagName}`;
	if (
		!body
			.slice(startIndex, startIndex + openPrefix.length)
			.toLowerCase()
			.startsWith(openPrefix)
	) {
		return -1;
	}

	let quote: string | null = null;
	for (let index = startIndex; index < body.length; index += 1) {
		const char = body[index];
		if ((char === '"' || char === "'") && body[index - 1] !== "\\") {
			if (quote === char) {
				quote = null;
			} else if (!quote) {
				quote = char;
			}
			continue;
		}

		if (char === ">" && !quote) {
			return index;
		}
	}

	return -1;
}

/**
 * Trouve l'index de fin de la balise fermante correspondante, en gérant l'imbrication
 * de balises de même type.
 *
 * @param body Le document HTML.
 * @param startIndex L'index de début de la balise ouvrante cible.
 * @param tagName Le nom de la balise.
 * @returns L'index juste après la balise fermante, ou `-1` en cas d'erreur.
 */
function findMatchingTagEnd(body: string, startIndex: number, tagName: string): number {
	const openPattern = new RegExp(`<${tagName}\\b`, "gi");
	const closePattern = new RegExp(`</${tagName}\\s*>`, "gi");
	const tokens: Array<{ index: number; type: "open" | "close"; end: number }> = [];
	const openTagEnd = findTagEnd(body, startIndex, tagName);
	if (openTagEnd === -1) {
		return -1;
	}

	for (const match of body.slice(openTagEnd + 1).matchAll(openPattern)) {
		if (typeof match.index === "number") {
			const absoluteIndex = openTagEnd + 1 + match.index;
			tokens.push({ index: absoluteIndex, type: "open", end: absoluteIndex + match[0].length });
		}
	}

	for (const match of body.slice(openTagEnd + 1).matchAll(closePattern)) {
		if (typeof match.index === "number") {
			const absoluteIndex = openTagEnd + 1 + match.index;
			tokens.push({ index: absoluteIndex, type: "close", end: absoluteIndex + match[0].length });
		}
	}

	tokens.sort((left, right) => left.index - right.index || (left.type === "close" ? 1 : -1));

	let depth = 1;
	for (const token of tokens) {
		if (token.type === "open") {
			depth += 1;
			continue;
		}

		depth -= 1;
		if (depth === 0) {
			return token.end;
		}
	}

	return -1;
}

/**
 * Échappe les caractères spéciaux d'une chaîne pour l'utiliser en toute sécurité dans une expression régulière.
 *
 * @param input La chaîne de caractères à échapper.
 * @returns La chaîne échappée.
 */
function escapeRegExp(input: string): string {
	return input.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
