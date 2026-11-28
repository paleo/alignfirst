import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCapturedRequest } from "../scripts/lightweight-fixture.ts";

test("request capture tolerates presentation but retains every requirement", () => {
  const expected =
    "Sur nimbus, sans ticket, améliore le libellé d'export.\n\n- Remplace Export par Download dans label.mjs.\n- Adapte le test label.test.mjs et exécute npm test.\n- Ne pousse rien.";
  const presented =
    "# Demande\nSur nimbus, sans ticket externe, améliore le libellé d’export.\n\n- Remplace « Export » par « Download » dans `label.mjs`.\n- Adapte le test `label.test.mjs` et exécute `npm test`.\n- Ne pousse rien.";
  assertCapturedRequest(expected);
  assertCapturedRequest(presented);
  assertCapturedRequest(presented.replace("Adapte le test", "Adapte"));
  assertCapturedRequest(
    presented
      .replace("Remplace", "Remplacer")
      .replace("Adapte", "Adapter")
      .replace("exécute", "exécuter")
      .replace("Ne pousse rien", "Ne rien pousser"),
  );
  for (const missing of ["sans ticket externe, ", "et exécute `npm test`", "- Ne pousse rien."]) {
    assert.throws(() => assertCapturedRequest(presented.replace(missing, "")));
  }
});
