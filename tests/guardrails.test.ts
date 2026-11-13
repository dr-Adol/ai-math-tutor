import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, leaksAnswer, isGoodFollowUp, templateProblem } from "../lib/guardrails.ts";
import { verifyStudentMessage, analyzeEquation } from "../lib/verifier.ts";
import type { TutorReply, ExerciseContext } from "../lib/types.ts";

const P = "3(x + 4) = 2x + 19";
const ex = (over: Partial<ExerciseContext> = {}): ExerciseContext => ({ problem: P, origin: "assigned", mistakesSoFar: [], hintLevel: 0, consecutiveErrors: 0, ...over });
const reply = (over: Partial<TutorReply> = {}): TutorReply => ({
  message: "ok", status: "correct_step", error_type: null, error_description: null, skill: "s",
  hint_level: 0, problem_solved: false, follow_up_problem: null, ...over,
});

test("invalid line forces an error even if the model missed it", () => {
  const { reply: r } = reconcile(reply(), verifyStudentMessage(P, "3x + 4 = 2x + 19"), ex());
  assert.equal(r.status, "error");
  assert.ok(r.error_type);
  assert.ok(r.error_description);
});

test("model cannot declare victory without a verified answer", () => {
  const { reply: r } = reconcile(reply({ problem_solved: true, status: "final_correct" }), verifyStudentMessage(P, "x = 15"), ex());
  assert.equal(r.problem_solved, false);
});

test("solved after a mistake requires a valid follow-up", () => {
  const v = verifyStudentMessage(P, "x = 7");
  const mistakes = [{ type: "distributive_property_partial", description: "d" }];
  const good = reconcile(reply({ follow_up_problem: "5(x - 2) = 3x + 6" }), v, ex({ mistakesSoFar: mistakes }));
  assert.equal(good.reply.problem_solved, true);
  assert.equal(good.needsFollowUp, false);
  const bad = reconcile(reply({ follow_up_problem: "-2(x - 5) = 3x + 1" }), v, ex({ mistakesSoFar: mistakes })); // x = 1.8
  assert.equal(bad.needsFollowUp, true);
  assert.equal(bad.reply.follow_up_problem, null);
});

test("no follow-up when solved without mistakes or on a follow-up exercise", () => {
  const v = verifyStudentMessage(P, "x = 7");
  assert.equal(reconcile(reply({ follow_up_problem: "5(x - 2) = 3x + 6" }), v, ex()).reply.follow_up_problem, null);
  const m = [{ type: "t", description: "d" }];
  assert.equal(reconcile(reply({ follow_up_problem: "5(x - 2) = 3x + 6" }), v, ex({ origin: "follow_up", mistakesSoFar: m })).reply.follow_up_problem, null);
});

test("answer leak detection", () => {
  assert.equal(leaksAnswer("Almost! The answer is x = 7.", P), true);
  assert.equal(leaksAnswer("So 7 = x, right?", P), true);
  assert.equal(leaksAnswer("Your line gives x = 15, but check the bracket.", P), false);
  assert.equal(leaksAnswer("What is 3 · 4?", P), false);
});

test("template problems are always well-posed", () => {
  for (let i = 0; i < 500; i++) {
    const p = templateProblem();
    assert.ok(isGoodFollowUp(p, P), p);
    assert.equal(analyzeEquation(p, "x").kind, "unique");
  }
});

test("hint level is clamped", () => {
  assert.equal(reconcile(reply({ hint_level: 9 }), verifyStudentMessage(P, "hi"), ex()).reply.hint_level, 4);
});
