import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStudentMessage, extractEquations, analyzeEquation } from "../lib/verifier.ts";

const P = "3(x + 4) = 2x + 19";

test("original problem has x = 7", () => {
  assert.deepEqual(analyzeEquation(P, "x"), { equation: P, kind: "unique", solution: 7 });
});

test("test scenario: 3x + 4 = 2x + 19 is flagged as invalid", () => {
  const r = verifyStudentMessage(P, "3x + 4 = 2x + 19");
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].equivalent, false);
  assert.equal(r.steps[0].solution, 15);
});

test("correct expansion and final answer are valid", () => {
  const r = verifyStudentMessage(P, "I expand: 3x + 12 = 2x + 19, then x = 7.");
  assert.deepEqual(r.steps.map((s) => [s.equation, s.equivalent, s.isFinalAnswer]), [
    ["3x + 12 = 2x + 19", true, false],
    ["x = 7", true, true],
  ]);
});

test("words containing the variable letter are ignored", () => {
  assert.deepEqual(extractEquations("next I think x = 15 is the answer"), ["x = 15"]);
});

test("unicode minus and multiplication", () => {
  const r = verifyStudentMessage("−2(x − 5) = 3x + 1", "−2x + 10 = 3x + 1");
  assert.equal(r.steps[0].equivalent, true);
});

test("no equations in a question", () => {
  assert.equal(verifyStudentMessage(P, "I don't understand, why?").steps.length, 0);
});
