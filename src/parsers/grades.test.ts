import { describe, expect, test } from "bun:test";

import { parseGrades } from "./grades";

describe("parseGrades", () => {
	test("ignores unrelated table rows instead of shifting grade columns", () => {
		const body = `
			<table><tbody>
				<tr><td>Navigation</td><td>Autre section</td></tr>
				<tr>${Array.from({ length: 11 }, (_, index) => `<td><span class="preformatted">${index === 0 ? "15/06/2026" : `field-${index}`}</span></td>`).join("")}</tr>
			</tbody></table>
		`;

		const grades = parseGrades(body);

		expect(grades).toHaveLength(1);
		expect(grades[0]?.date).toBe("15/06/2026");
	});
});
