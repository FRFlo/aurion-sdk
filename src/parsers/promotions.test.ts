import { describe, expect, test } from "bun:test";

import { parseAvailablePlannings } from "./promotions";

describe("parseAvailablePlannings", () => {
	test("extracts every planning column from ChoixPlanning rows", () => {
		const body = `
<table class="ui-datatable"><thead><tr>
	<th>Sélectionner</th><th>Code</th><th>Libellé</th><th>Fin de validité</th><th>Libellé</th>
</tr></thead><tbody>
	<tr data-rk="rk-1">
		<td><input type="checkbox" /></td>
		<td>2526_ISEN_AP3</td>
		<td>Promotion 3ème année ISEN Apprentissage 2025-2026</td>
		<td>31/08/2026</td>
		<td>Promotion</td>
	</tr>
	<tr data-rk="rk-2">
		<td><input type="checkbox" /></td>
		<td>2526_ISEN_AP3_GR1</td>
		<td>AP3 - Groupe 1</td>
		<td>31/08/2026</td>
		<td>Planning</td>
	</tr>
</tbody></table>`;

		expect(parseAvailablePlannings(body)).toEqual([
			{
				id: "rk-1",
				name: "Promotion 3ème année ISEN Apprentissage 2025-2026",
				code: "2526_ISEN_AP3",
				label: "Promotion 3ème année ISEN Apprentissage 2025-2026",
				validityEnd: "31/08/2026",
				kind: "Promotion",
			},
			{
				id: "rk-2",
				name: "AP3 - Groupe 1",
				code: "2526_ISEN_AP3_GR1",
				label: "AP3 - Groupe 1",
				validityEnd: "31/08/2026",
				kind: "Planning",
			},
		]);
	});
});
