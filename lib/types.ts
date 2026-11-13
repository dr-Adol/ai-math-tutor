export type Role = "user" | "assistant";

export interface ChatTurn {
  role: Role;
  content: string;
}

export type StepStatus = "correct_step" | "error" | "final_correct" | "question" | "other";

/** Structured reply produced by the model (enforced by JSON schema). */
export interface TutorReply {
  message: string;
  status: StepStatus;
  /** short snake_case code of the misconception, e.g. "distributive_property_partial" */
  error_type: string | null;
  /** one-sentence diagnosis of the reasoning error (for the mistake log) */
  error_description: string | null;
  /** skill this turn is about, e.g. "distributive_property" */
  skill: string;
  /** 0 = no help yet, 1 = leading question, 2 = rule reminder, 3 = analogous example, 4 = step shown */
  hint_level: number;
  problem_solved: boolean;
  /** new, similar problem to verify understanding (only after a corrected mistake) */
  follow_up_problem: string | null;
}

export interface ExerciseContext {
  problem: string;
  origin: "assigned" | "follow_up";
  /** misconception that the follow-up problem is meant to verify */
  targetSkill?: string | null;
  mistakesSoFar: { type: string; description: string }[];
  hintLevel: number;
  /** consecutive wrong attempts on the current step (drives hint escalation) */
  consecutiveErrors: number;
}

export interface TutorRequest {
  exercise: ExerciseContext;
  messages: ChatTurn[];
  /** compact summary of the learner's history across exercises */
  learnerSummary?: string;
}

export interface TutorResponse {
  reply: TutorReply;
  verifier: import("./verifier").VerifierReport;
}
