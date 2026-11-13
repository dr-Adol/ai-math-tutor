/**
 * Deterministic math verifier.
 *
 * The LLM is good at explaining *why* a step is wrong, but it should never be
 * the only judge of *whether* a step is wrong. This module checks every
 * equation the student writes against the original problem symbolically:
 * a valid transformation of a linear equation must preserve its solution set.
 *
 * The result is passed to the model as ground truth, so the tutor can focus
 * on diagnosing the misconception behind an invalid step.
 */
import { parse } from "mathjs";

export interface LinearForm {
  /** lhs - rhs == a*v + b */
  a: number;
  b: number;
  variable: string;
}

export type SolutionKind = "unique" | "none" | "all" | "nonlinear" | "unparseable";

export interface EquationAnalysis {
  equation: string;
  kind: SolutionKind;
  solution?: number;
}

export interface StepCheck {
  equation: string;
  /** true if the line has exactly the same solution set as the original problem */
  equivalent: boolean;
  /** true if the line is a final answer of the form `x = number` */
  isFinalAnswer: boolean;
  kind: SolutionKind;
  solution?: number;
}

export interface VerifierReport {
  problem: string;
  variable: string;
  problemSolution?: number;
  steps: StepCheck[];
}

const EPS = 1e-9;

export function normalize(raw: string): string {
  return raw
    .replace(/[−–—]/g, "-")
    .replace(/[×·∙]/g, "*")
    .replace(/÷|:/g, "/")
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

/** Guess the single unknown used in a problem (x by default). */
export function detectVariable(problem: string): string {
  const letters = normalize(problem).match(/[a-z]/gi) ?? [];
  const uniq = Array.from(new Set(letters.map((l) => l.toLowerCase())));
  return uniq.length === 1 ? uniq[0] : "x";
}

function evaluateSide(expr: string, variable: string, value: number): number {
  const node = parse(expr);
  const result = node.evaluate({ [variable]: value });
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("non-numeric");
  return result;
}

export function toLinearForm(equation: string, variable: string): LinearForm | "nonlinear" | null {
  const eq = normalize(equation).toLowerCase();
  const parts = eq.split("=");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
  const [lhs, rhs] = parts;
  try {
    const f = (v: number) => evaluateSide(lhs, variable, v) - evaluateSide(rhs, variable, v);
    const f0 = f(0), f1 = f(1), f2 = f(2), f5 = f(-5);
    const a = f1 - f0;
    // linearity check at extra points
    if (Math.abs(f2 - (f0 + 2 * a)) > 1e-6 || Math.abs(f5 - (f0 - 5 * a)) > 1e-6) return "nonlinear";
    return { a, b: f0, variable };
  } catch {
    return null;
  }
}

export function analyzeEquation(equation: string, variable: string): EquationAnalysis {
  const form = toLinearForm(equation, variable);
  if (form === null) return { equation, kind: "unparseable" };
  if (form === "nonlinear") return { equation, kind: "nonlinear" };
  if (Math.abs(form.a) < EPS) return { equation, kind: Math.abs(form.b) < EPS ? "all" : "none" };
  return { equation, kind: "unique", solution: round(-form.b / form.a) };
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/**
 * Pull candidate equations out of free text such as
 * "so I get 3x + 4 = 2x + 19, then x = 15".
 */
export function extractEquations(text: string, variable = "x"): string[] {
  const v = variable.replace(/[^a-z]/gi, "") || "x";
  const charClass = new RegExp(`[0-9${v}${v.toUpperCase()}+\\-−–*/×·÷().^ =,]+`, "g");
  const out: string[] = [];
  for (const rawLine of text.split(/\n|;|,\s|\.\s|\.$/)) {
    const line = normalize(rawLine);
    for (const m of line.match(charClass) ?? []) {
      const candidate = m.trim().replace(/^[=+*/^. ]+|[=+\-*/^. ]+$/g, "");
      if ((candidate.match(/=/g) ?? []).length !== 1) continue;
      const [l, r] = candidate.split("=");
      if (!/[0-9a-z]/i.test(l) || !/[0-9a-z]/i.test(r)) continue;
      out.push(candidate);
    }
  }
  return out;
}

export function verifyStudentMessage(problem: string, message: string): VerifierReport {
  const variable = detectVariable(problem);
  const original = analyzeEquation(problem, variable);
  const steps: StepCheck[] = extractEquations(message, variable).map((eq) => {
    const a = analyzeEquation(eq, variable);
    const equivalent =
      original.kind === a.kind &&
      (a.kind !== "unique" || Math.abs((a.solution ?? NaN) - (original.solution ?? NaN)) < 1e-6);
    const isFinalAnswer = new RegExp(`^\\s*${variable}\\s*=\\s*-?[0-9.]+\\s*$|^\\s*-?[0-9.]+\\s*=\\s*${variable}\\s*$`, "i").test(eq);
    return { equation: eq, equivalent: a.kind === "unparseable" ? false : equivalent, isFinalAnswer, kind: a.kind, solution: a.solution };
  });
  return { problem, variable, problemSolution: original.solution, steps };
}

/** Human/LLM-readable version of the report. Never shown to the student verbatim. */
export function describeReport(r: VerifierReport): string {
  if (r.steps.length === 0) return "No equations found in the student's last message.";
  return r.steps
    .map((s) => {
      if (s.kind === "unparseable") return `- "${s.equation}": could not be parsed (may be a typo).`;
      if (s.equivalent)
        return `- "${s.equation}": VALID — equivalent to the original equation${s.isFinalAnswer ? " and it is the correct final answer" : ""}.`;
      const got = s.kind === "unique" ? `${r.variable} = ${s.solution}` : s.kind === "none" ? "no solution" : s.kind === "all" ? "every number" : "a non-linear equation";
      return `- "${s.equation}": INVALID — not equivalent to the original. The original has ${r.variable} = ${r.problemSolution}, this line gives ${got}. An error was introduced in this step or earlier.`;
    })
    .join("\n");
}
