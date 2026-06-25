import { describe, expect, test } from "bun:test";

import { parseEventDetails, parsePlanningEvents } from "./planning";

describe("parseEventDetails", () => {
	test("parses the saved empty planning events partial response", async () => {
		const body = await Bun.file("aurion-cursus-161-response-body.txt").text();

		expect(parsePlanningEvents(body)).toEqual([]);
	});

	test("parses populated planning events whose titles contain square brackets", () => {
		const payload = JSON.stringify({
			events: [
				{
					id: "66383287",
					title: "J104_COURS\n\n[ADI1] Mécanique du solide",
					start: "2026-05-26T13:30:00+0200",
					end: "2026-05-26T16:30:00+0200",
					allDay: false,
					editable: true,
					className: "COURS_TD",
				},
			],
		});
		const body = `<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><changes><update id="form:j_idt118"><![CDATA[${payload}]]></update></changes></partial-response>`;

		const events = parsePlanningEvents(body);

		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("66383287");
		expect(events[0]?.title).toContain("[ADI1]");
		expect(events[0]?.type).toBe("COURS_TD");
	});

	test("parses the real Aurion event detail partial response", async () => {
		const body = await Bun.file("response-getEventDetails.xml").text();

		const details = parseEventDetails(body, "70063950");

		expect(details.eventId).toBe("70063950");
		expect(details.start.getFullYear()).toBe(2026);
		expect(details.start.getMonth()).toBe(5);
		expect(details.start.getDate()).toBe(15);
		expect(details.start.getHours()).toBe(13);
		expect(details.start.getMinutes()).toBe(30);
		expect(details.end.getFullYear()).toBe(2026);
		expect(details.end.getMonth()).toBe(5);
		expect(details.end.getDate()).toBe(15);
		expect(details.end.getHours()).toBe(17);
		expect(details.end.getMinutes()).toBe(55);
		expect(details.status).toBe("Planifié");
		expect(details.subject).toBe("Pédagogique");
		expect(details.teachingType).toBe("Projet");
		expect(details.description).toBeNull();
		expect(details.isExam).toBe(false);
		expect(details.resources).toEqual([
			{
				code: "ROOM_A1",
				name: "ROOM A1 - LAB",
			},
		]);
		expect(details.teachers).toEqual([
			{
				lastName: "DOE",
				firstName: "Jane",
			},
		]);
		expect(details.students).toHaveLength(31);
		expect(details.students).toContainEqual({
			lastName: "HODKIEWICZ",
			firstName: "Kadin",
		});
		expect(details.groups).toEqual([
			{
				code: "YEAR3_CS",
				name: "Computer Science Year 3",
			},
		]);
		expect(details.courses).toEqual([
			{
				code: "YEAR3_CS_ELEC_PROJ",
				course: "Software Project",
				module: "Unité d'Enseignement Electronique, Signaux et Systèmes",
			},
		]);
	});
});
