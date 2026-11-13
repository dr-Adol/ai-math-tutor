/**
 * Deterministic rules applied to every model reply.
 * Pure functions (no network) so they can be unit-tested.
 */
import type { ExerciseContext, TutorReply } from "./types";
import { analyzeEquation, detectVariable, extractEquations, type VerifierReport } from "./verifier.ts";

export interface ReconcileResult {
  reply: TutorReply;
  /** the follow-up problem from the model was missing/invalid and must be regenerated */
  needsFollowUp: boolean;
}

/** Make the model's reply consistent with the symbolic verifier. */
export function reconcile(input: TutorReply, v: VerifierReport, ex: ExerciseContext): ReconcileResult {
  const reply: TutorReply = { ...input, hint_level: clampInt(input.hint_level, 0, 4) };
  const invalid = v.steps.find((s) => !s.equivalent && s.kind !== "unparseable");
  const solved = v.steps.some((s) => s.equivalent && s.isFinalAnswer);

  // An invalid equation is always an error, whatever the model said.
  if (invalid && reply.status !== "error") reply.status = "error";
  if (reply.status === "error") {
    reply.error_type ||= "invalid_transformation";
    reply.error_description ||= invalid
      ? `Wrote "${invalid.equation}", which is not equivalent to the original equation.`
      : "Reasoning error in the explanation.";
  } else {
    reply.error_type = null;
    reply.error_description = null;
  }

  // Only the verifier can declare the problem solved.
  if (solved && !invalid) {
    reply.problem_solved = true;
    reply.status = "final_correct";
  } else {
    reply.problem_solved = false;
  }

  const hadMistakes = ex.mistakesSoFar.length > 0 || reply.status === "error";
  const wantsFollowUp = reply.problem_solved && ex.origin === "assigned" && hadMistakes;
  if (!wantsFollowUp) {
    reply.follow_up_problem = null;
    return { reply, needsFollowUp: false };
  }
  if (isGoodFollowUp(reply.follow_up_problem, ex.problem)) return { reply, needsFollowUp: false };
  reply.follow_up_problem = null;
  return { reply, needsFollowUp: true };
}

/**
 * Did the tutor give away the final answer of an unsolved problem?
 * Looks for "x = <solution>" (or "<solution> = x") in the tutor's own message.
 */
export function leaksAnswer(message: string, problem: string): boolean {
  const variable = detectVariable(problem);
  const original = analyzeEquation(problem, variable);
  if (original.kind !== "unique") return false;
  return extractEquations(message, variable).some((eq) => {
    const a = analyzeEquation(eq, variable);
    const isAnswerForm = new RegExp(`^\\s*${variable}\\s*=\\s*-?[0-9.]+\\s*$|^\\s*-?[0-9.]+\\s*=\\s*${variable}\\s*$`, "i").test(eq);
    return isAnswerForm && a.kind === "unique" && Math.abs((a.solution ?? NaN) - (original.solution ?? NaN)) < 1e-6;
  });
}

export function isGoodFollowUp(p: string | null | undefined, original: string): p is string {
  if (!p || p.length > 80 || p.replace(/\s/g, "") === original.replace(/\s/g, "")) return false;
  const a = analyzeEquation(p, detectVariable(p));
  return a.kind === "unique" && Number.isInteger(a.solution);
}

/** Last-resort deterministic generator: a(x ± b) = cx ± d with an integer root. */
export function templateProblem(rand: () => number = Math.random): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const a = pick([2, 3, 4, 5, -2, -3]);
  const b = pick([-6, -5, -3, -2, 2, 3, 4, 5]);
  const x = pick([-3, -2, -1, 1, 2, 3, 4, 5, 6]);
  const c = pick([1, 2, 3, -1].filter((v) => v !== a));
  const d = a * (x + b) - c * x;
  const sign = (n: number) => (n < 0 ? `- ${-n}` : `+ ${n}`);
  const cx = c === 1 ? "x" : c === -1 ? "-x" : `${c}x`;
  return `${a}(x ${sign(b)}) = ${cx}${d === 0 ? "" : ` ${sign(d)}`}`;
}

function clampInt(n: unknown, min: number, max: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
