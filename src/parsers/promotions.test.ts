import { describe, expect, test } from "bun:test";

import { parseAvailablePlannings, parseMenuChildren, parseSubmenuId } from "./promotions";

describe("promotion planning parsers", () => {
	test("parseSubmenuId resolves the grouped plannings menu entry", () => {
		const body = `
			<a onclick="PrimeFaces.addSubmitParam('form',{'webscolaapp.Sidebar.ID_SUBMENU':'submenu_3131476'})">
				<span>Plannings Groupés par Promotion</span>
			</a>
		`;

		expect(parseSubmenuId(body, "Plannings Groupés par Promotion")).toBe("submenu_3131476");
	});

	test("parseMenuChildren returns direct submenu and item entries", () => {
		const body = `
			<li id="submenu_parent">
				<a onclick="PrimeFaces.addSubmitParam('form',{'webscolaapp.Sidebar.ID_SUBMENU':'submenu_child'})"><span>ISEN</span></a>
				<ul><li id="submenu_child"></li></ul>
				<a onclick="PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'3_0_6_1'})"><span>AP3</span></a>
			</li>
		`;

		expect(parseMenuChildren(body, "submenu_parent")).toEqual([
			{
				type: "submenu",
				id: "submenu_child",
				name: "ISEN",
				isLoaded: true,
			},
			{
				type: "item",
				id: "3_0_6_1",
				name: "AP3",
			},
		]);
	});

	test("parseAvailablePlannings extracts planning rows", () => {
		const body = `
			<table><tbody>
				<tr data-rk="60288885">
					<td><input name="form:j_idt181_checkbox" value="60288885" /></td>
					<td>ISEN AP3</td>
				</tr>
			</tbody></table>
		`;

		expect(parseAvailablePlannings(body)).toEqual([
			{
				id: "60288885",
				name: "ISEN AP3",
			},
		]);
	});
});
