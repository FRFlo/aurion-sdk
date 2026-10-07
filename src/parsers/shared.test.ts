import { describe, expect, test } from "bun:test";

import { normalizeText, parseViewState } from "./shared";

describe("shared HTML parsers", () => {
	test("parses ViewState regardless of input attribute order", () => {
		expect(parseViewState('<input value="state-token" name="javax.faces.ViewState">')).toBe(
			"state-token",
		);
	});

	test("decodes common French named and numeric HTML entities", () => {
		expect(normalizeText("M&eacute;canique &#xE9; &amp; r&eacute;seau")).toBe(
			"Mécanique é & réseau",
		);
	});
});
