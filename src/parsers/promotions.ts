import { normalizeText, throwParsingError } from "./shared";

export interface PromotionMenuEntry {
	type: "submenu" | "item";
	id: string;
	name: string;
	isLoaded?: boolean;
}

/** Résout un identifiant de sous-menu PrimeFaces à partir d'un libellé visible. */
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

/** Parse les enfants directs d'un nœud de menu Aurion. */
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

/** Parse les plannings sélectionnables affichés dans ChoixPlanning. */
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
		const name = cells.at(-1) ?? normalizeText(row);
		if (name) {
			plannings.set(id, name);
		}
	}

	return Array.from(plannings, ([id, name]) => ({ id, name }));
}

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

function extractAncestorListItem(body: string, childIndex: number): string | null {
	const listItemStart = body.lastIndexOf("<li", childIndex);
	if (listItemStart === -1) {
		return null;
	}

	return extractBalancedElement(body.slice(listItemStart), "li");
}

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

function extractSubmenuId(markup: string): string | null {
	return (
		markup.match(/webscolaapp\.Sidebar\.ID_SUBMENU["']?\s*[:=]\s*["']([^"'&]+)["']/i)?.[1] ??
		markup.match(/ID_SUBMENU["']?\s*,\s*["']([^"']+)["']/i)?.[1] ??
		markup.match(/ID_SUBMENU=([^&"'\s)]+)/i)?.[1] ??
		markup.match(/\b(submenu_\d+)\b/i)?.[1] ??
		null
	);
}

function extractSidebarMenuId(markup: string): string | null {
	return (
		markup.match(/form:sidebar_menuid["']?\s*:\s*["']([^"']+)["']/i)?.[1] ??
		markup.match(/form:sidebar_menuid=([^&"'\s)]+)/i)?.[1] ??
		null
	);
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
