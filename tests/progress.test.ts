import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReply, emptyProgress, newExercise, stats, learnerSummary } from "../lib/progress.ts";
import type { TutorReply } from "../lib/types.ts";

const r = (over: Partial<TutorReply>): TutorReply => ({
  message: "", status: "other", error_type: null, error_description: null, skill: "s",
  hint_level: 0, problem_solved: false, follow_up_problem: null, ...over,
});

test("full scenario: mistake -> fix -> follow-up -> skill verified", () => {
  let p = emptyProgress();
  const ex = newExercise("3(x + 4) = 2x + 19");
  p.exercises.push(ex);

  p = applyReply(p, ex.id, r({ status: "error", error_type: "distributive_property_partial", error_description: "only x multiplied", hint_level: 1 }), "3x + 4 = 2x + 19").progress;
  assert.equal(p.exercises[0].mistakes.length, 1);
  assert.equal(p.exercises[0].consecutiveErrors, 1);
  assert.equal(p.skills.distributive_property_partial.mistakes, 1);

  p = applyReply(p, ex.id, r({ status: "correct_step" }), "3x + 12 = 2x + 19").progress;
  assert.equal(p.exercises[0].consecutiveErrors, 0);

  const step = applyReply(p, ex.id, r({ status: "final_correct", problem_solved: true, follow_up_problem: "5(x - 2) = 3x + 6" }), "x = 7");
  p = step.progress;
  assert.ok(step.followUp);
  assert.equal(step.followUp!.targetSkill, "distributive_property_partial");
  assert.equal(p.exercises[0].status, "solved");

  p = applyReply(p, step.followUp!.id, r({ status: "final_correct", problem_solved: true }), "x = 8").progress;
  assert.equal(p.skills.distributive_property_partial.verified, true);

  const st = stats(p);
  assert.deepEqual([st.completed, st.mistakes, st.accuracy, st.verifiedSkills], [2, 1, 50, 1]);
  assert.match(learnerSummary(p), /Verified after correction: distributive_property_partial/);
});
