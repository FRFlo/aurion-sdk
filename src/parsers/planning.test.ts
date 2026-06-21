import { describe, expect, test } from "bun:test";

import { parseEventDetails } from "./planning";

describe("parseEventDetails", () => {
	test("extracts adjacent fields and parses French date rows", () => {
		const body = `
<partial-response id="j_id1">
  <changes>
    <update id="form:modaleDetail"><![CDATA[
      <div id="form:modaleDetail">
        <table class="ui-panelgrid ui-widget panelgrid-debut-fin" role="grid"><tbody>
          <tr class="ui-widget-content" role="row">
            <td role="gridcell" class="ui-panelgrid-cell"><label class="label"><span class="label">Du</span></label></td>
            <td role="gridcell" class="ui-panelgrid-cell">lundi 9 février 2026</td>
            <td role="gridcell" class="ui-panelgrid-cell"><label class="label"><span class="label">à</span></label></td>
            <td role="gridcell" class="ui-panelgrid-cell">08:00</td>
          </tr>
          <tr class="ui-widget-content" role="row">
            <td role="gridcell" class="ui-panelgrid-cell"><label class="label"><span class="label">Au</span></label></td>
            <td role="gridcell" class="ui-panelgrid-cell">dimanche 8 décembre 2026</td>
            <td role="gridcell" class="ui-panelgrid-cell"><label class="label"><span class="label">à</span></label></td>
            <td role="gridcell" class="ui-panelgrid-cell">09:00</td>
          </tr>
        </tbody></table>
        <div class="ui-grid-row">
          <div class="ui-panelgrid-cell ui-grid-col-6"><label class="label"><span class="label">Statut</span></label></div>
          <div class="ui-panelgrid-cell ui-grid-col-6">Planifié facultatif</div>
        </div>
        <div class="ui-grid-row">
          <div class="ui-panelgrid-cell ui-grid-col-6"><label class="label"><span class="label">Matière</span></label></div>
          <div class="ui-panelgrid-cell ui-grid-col-6">Pédagogique</div>
        </div>
        <div class="ui-grid-row">
          <div class="ui-panelgrid-cell ui-grid-col-6"><label class="label"><span class="label">Type d'enseignement</span></label></div>
          <div class="ui-panelgrid-cell ui-grid-col-6">Entreprise</div>
        </div>
        <div class="ui-grid-row">
          <div class="ui-panelgrid-cell ui-grid-col-6"><label class="ev_libelle"><span class="ev_libelle">Description</span></label></div>
          <div class="ui-panelgrid-cell ui-grid-col-6"></div>
        </div>
        <div class="ui-grid-row">
          <div class="ui-panelgrid-cell ui-grid-col-6"><label class="label"><span class="label">Est une épreuve</span></label></div>
          <div class="ui-panelgrid-cell ui-grid-col-6">Oui</div>
        </div>
      </div>

		      <ul class="ui-tabs-nav ui-helper-reset ui-helper-clearfix ui-widget-header ui-corner-all">
        <li><a href="#form:onglets:j_idt201">Ressources</a></li>
        <li><a href="#form:onglets:j_idt202">Intervenants</a></li>
        <li><a href="#form:onglets:j_idt203">Apprenants (31)</a></li>
        <li><a href="#form:onglets:j_idt204">Groupes</a></li>
        <li><a href="#form:onglets:j_idt205">Cours</a></li>
      </ul>

      <div id="form:onglets:j_idt204" class="ui-tabs-panel">
        <table class="ui-datatable"><thead><tr><th>Code</th><th>Libellé</th></tr></thead><tbody>
          <tr><td>GRP1</td><td>Groupe 1</td></tr>
        </tbody></table>
      </div>

      <div id="form:onglets:j_idt205" class="ui-tabs-panel">
        <table class="ui-datatable"><thead><tr><th>Code</th><th>Cours</th><th>Module</th></tr></thead><tbody>
          <tr><td>COURSE1</td><td>Cours 1</td><td>Module A</td></tr>
        </tbody></table>
      </div>

      <div id="form:onglets:j_idt203" class="ui-tabs-panel">
        <table class="ui-datatable"><thead><tr><th>Nom</th><th>Prénom</th></tr></thead><tbody>
          <tr><td>Dupont</td><td>Marie</td></tr>
        </tbody></table>
      </div>

      <div id="form:onglets:j_idt202" class="ui-tabs-panel">
        <table class="ui-datatable"><thead><tr><th>Nom</th><th>Prénom</th></tr></thead><tbody>
          <tr><td>Martin</td><td>Jean</td></tr>
        </tbody></table>
      </div>

      <div id="form:onglets:j_idt201" class="ui-tabs-panel">
        <table class="ui-datatable"><thead><tr><th>Code</th><th>Libellé</th></tr></thead><tbody>
          <tr><td>RES1</td><td>Ressource 1</td></tr>
        </tbody></table>
      </div>
    ]]></update>
  </changes>
</partial-response>`;

		const details = parseEventDetails(body, "evt-123");

		expect(details.eventId).toBe("evt-123");
		expect(details.status).toBe("Planifié facultatif");
		expect(details.subject).toBe("Pédagogique");
		expect(details.teachingType).toBe("Entreprise");
		expect(details.description).toBeNull();
		expect(details.isExam).toBe(true);
		expect(details.teachers).toEqual([{ lastName: "Martin", firstName: "Jean" }]);
		expect(details.students).toEqual([{ lastName: "Dupont", firstName: "Marie" }]);
		expect(details.groups).toEqual([{ code: "GRP1", name: "Groupe 1" }]);
		expect(details.courses).toEqual([{ code: "COURSE1", course: "Cours 1", module: "Module A" }]);
		expect(details.resources).toEqual([{ code: "RES1", name: "Ressource 1" }]);
		expect(details.start.getFullYear()).toBe(2026);
		expect(details.start.getMonth()).toBe(1);
		expect(details.start.getDate()).toBe(9);
		expect(details.start.getHours()).toBe(8);
		expect(details.start.getMinutes()).toBe(0);
		expect(details.end.getFullYear()).toBe(2026);
		expect(details.end.getMonth()).toBe(11);
		expect(details.end.getDate()).toBe(8);
		expect(details.end.getHours()).toBe(9);
		expect(details.end.getMinutes()).toBe(0);
	});
});
