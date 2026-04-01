import { createAurionError } from "./errors";

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

/**
 * Adresse d'un bâtiment avec les champs de base pour une adresse postale française.
 */
export interface Address {
	/* Adresse d'un bâtiment avec les champs de base pour une adresse postale française. */
	street: string;
	/* Code postal de l'adresse. */
	postalCode: string;
	/* Ville de l'adresse. */
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
export function parseLocationToAddress(location: string): Address {
	for (const keyword in locationAddressByKeyword) {
		if (location.includes(keyword)) {
			const foundLocation = locationAddressByKeyword[keyword];
			if (!foundLocation) {
				throw createAurionError(
					"AURION_PARSING_ERROR",
					`Adresse non définie pour le mot-clé de localisation : ${keyword}`,
					{ location, keyword },
				);
			}
			return foundLocation;
		}
	}

	throw createAurionError(
		"AURION_PARSING_ERROR",
		`Impossible de déterminer l'adresse à partir de la location : ${location}`,
		{ location },
	);
}

/**
 * Champs extraits du code de note brut d'une note Aurion.
 */
export interface GradeDetails {
	/* La première année de l'année scolaire de la note. */
	startingYear: number;
	/* La seconde année de l'année scolaire de la note. */
	endingYear: number;
	/* L'école de la note */
	school: string;
	/* La classe de la note */
	class: string;
	/* Code de la note, le reste de l'information est à extraire de ce code. */
	code: string | undefined;
}

/**
 * Parse un code de note Aurion au format "2526_ISEN_AP3_PROG_PROJET" en extrayant les champs d'année, d'école, de classe et d'informations complémentaires.
 *
 * @param code Le code de note brut à parser.
 * @returns Un objet contenant les détails extraits du code de note.
 * @throws Si le format du code est invalide ou si des champs
 */
export function parseGradeToDetails(code: string): GradeDetails {
	const regex = /(\d{2})(\d{2})_([A-Z0-9]+)_([A-Z0-9]+)_(.+)/;
	const match = code.match(regex);

	if (!match) {
		throw new Error(`Code de note invalide : ${code}`);
	}

	const [, startingYearStr, endingYearStr, school, className, additionalInfo] = match;

	const startingYear = parseInt(startingYearStr ?? "", 10);
	const endingYear = parseInt(endingYearStr ?? "", 10);

	if (isNaN(startingYear) || isNaN(endingYear)) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			`Années invalides dans le code de la note : ${code}`,
			{ code },
		);
	}

	if (!school) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			`École manquante dans le code de la note : ${code}`,
			{ code },
		);
	}

	if (!className) {
		throw createAurionError(
			"AURION_PARSING_ERROR",
			`Classe manquante dans le code de la note : ${code}`,
			{ code },
		);
	}

	return {
		startingYear,
		endingYear,
		school,
		class: className,
		code: additionalInfo,
	};
}
