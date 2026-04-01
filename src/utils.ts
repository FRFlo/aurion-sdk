/** Champs extraits du titre brut d'un événement de planning Aurion. */
export interface ParsedAurionPlanningTitle {
	location: string | undefined;
	additionalInfo: string | undefined;
	subject: string | undefined;
	courseType: string | undefined;
	professor: string | undefined;
}

/**
 * Découpe un titre Aurion sur 5 lignes dans l'ordre : lieu, infos complémentaires,
 * matière, type de cours et professeur.
 */
export function parseAurionPlanningTitle(
	title: string,
	normalize: true,
): ParsedAurionPlanningTitle {
	const rawParts = title.split("\n").map((part) => part.trim());
	const [location, additionalInfo, subject, courseType, professor] = rawParts;

	return {
		location: normalizeText(location, normalize),
		additionalInfo: normalizeText(additionalInfo, normalize),
		subject: normalizeText(subject, normalize),
		courseType: normalizeText(courseType, normalize),
		professor: normalizeText(professor, normalize),
	};
}

/**
 * Normalise un texte en remplaçant les séquences de blancs par un espace simple et en supprimant les espaces en début et fin de chaîne.
 */
function normalizeText(text: string | undefined, normalize: boolean): string | undefined {
	if (!normalize || text === undefined) {
		return text;
	}

	return text.replace(/\s+/g, " ").trim();
}

export interface Address {
	street: string;
	postalCode: string;
	city: string;
}

const locationAddressByKeyword: Record<string, Address> = {
	ALG: {
		street: "2 Rue Norbert Segard",
		postalCode: "59800",
		city: "Lille",
	},
	MF: {
		street: "3 Rue Norbert Segard",
		postalCode: "59800",
		city: "Lille",
	},
	"Palais Rameau": {
		street: "39 Boulevard Vauban",
		postalCode: "59800",
		city: "Lille",
	},
	IC1: {
		street: "16 Rue Colson",
		postalCode: "59800",
		city: "Lille",
	},
	IC2: {
		street: "41 Boulevard Vauban",
		postalCode: "59800",
		city: "Lille",
	},
};

/**
 * Renvoie l'adresse du bâtiment à partir d'une sale Aurion, ou `undefined` si elle ne peut être déterminée de manière fiable.
 */
export function parseLocationToAddress(location: string | undefined): Address | undefined {
	if (!location) {
		return undefined;
	}

	for (const keyword in locationAddressByKeyword) {
		if (location.includes(keyword)) {
			return locationAddressByKeyword[keyword];
		}
	}

	return undefined;
}
