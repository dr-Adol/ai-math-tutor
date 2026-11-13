import type { TutorReply } from "./types";

export interface Mistake {
  type: string;
  description: string;
  studentLine?: string;
  at: number;
}

export interface Exercise {
  id: string;
  problem: string;
  origin: "assigned" | "follow_up";
  targetSkill: string | null;
  status: "in_progress" | "solved";
  mistakes: Mistake[];
  hintLevel: number;
  /** wrong attempts in a row on the current step */
  consecutiveErrors: number;
  startedAt: number;
  solvedAt?: number;
}

export interface SkillStat {
  mistakes: number;
  /** true once a follow-up problem for this skill was solved without errors */
  verified: boolean;
}

export interface Progress {
  exercises: Exercise[];
  skills: Record<string, SkillStat>;
}

export const emptyProgress = (): Progress => ({ exercises: [], skills: {} });

const KEY = "ai-math-tutor:progress:v1";

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Progress) : emptyProgress();
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

export function newExercise(problem: string, origin: Exercise["origin"] = "assigned", targetSkill: string | null = null): Exercise {
  return {
    id: Math.random().toString(36).slice(2, 10),
    problem,
    origin,
    targetSkill,
    status: "in_progress",
    mistakes: [],
    hintLevel: 0,
    consecutiveErrors: 0,
    startedAt: Date.now(),
  };
}

/** Pure reducer: apply one tutor reply to the progress state. */
export function applyReply(p: Progress, exerciseId: string, reply: TutorReply, studentLine: string): { progress: Progress; followUp: Exercise | null } {
  const progress: Progress = structuredClone(p);
  const ex = progress.exercises.find((e) => e.id === exerciseId);
  if (!ex) return { progress, followUp: null };

  ex.hintLevel = Math.max(ex.hintLevel, reply.hint_level || 0);
  if (reply.status === "error") ex.consecutiveErrors = (ex.consecutiveErrors ?? 0) + 1;
  else if (reply.status === "correct_step" || reply.status === "final_correct") ex.consecutiveErrors = 0;

  if (reply.status === "error" && reply.error_type) {
    ex.mistakes.push({ type: reply.error_type, description: reply.error_description ?? "", studentLine, at: Date.now() });
    const s = (progress.skills[reply.error_type] ??= { mistakes: 0, verified: false });
    s.mistakes += 1;
    s.verified = false;
  }

  if (reply.problem_solved && ex.status !== "solved") {
    ex.status = "solved";
    ex.solvedAt = Date.now();
    if (ex.origin === "follow_up" && ex.targetSkill && ex.mistakes.length === 0) {
      (progress.skills[ex.targetSkill] ??= { mistakes: 0, verified: false }).verified = true;
    }
  }

  let followUp: Exercise | null = null;
  if (reply.follow_up_problem) {
    const target = ex.mistakes.at(-1)?.type ?? reply.skill;
    followUp = newExercise(reply.follow_up_problem, "follow_up", target);
    progress.exercises.push(followUp);
  }
  return { progress, followUp };
}

export function stats(p: Progress) {
  const solved = p.exercises.filter((e) => e.status === "solved");
  const mistakes = p.exercises.reduce((n, e) => n + e.mistakes.length, 0);
  const firstTry = solved.filter((e) => e.mistakes.length === 0).length;
  const skills = Object.entries(p.skills);
  return {
    completed: solved.length,
    attempted: p.exercises.length,
    mistakes,
    accuracy: solved.length ? Math.round((firstTry / solved.length) * 100) : 0,
    verifiedSkills: skills.filter(([, s]) => s.verified).length,
    totalSkills: skills.length,
  };
}

/** Compact history the model can use to personalise explanations. */
export function learnerSummary(p: Progress): string {
  const st = stats(p);
  if (st.attempted === 0) return "";
  const weak = Object.entries(p.skills)
    .filter(([, s]) => !s.verified)
    .map(([k, s]) => `${k} (${s.mistakes}x)`);
  const strong = Object.entries(p.skills)
    .filter(([, s]) => s.verified)
    .map(([k]) => k);
  return [
    `${st.completed}/${st.attempted} exercises solved, ${st.mistakes} mistakes total.`,
    weak.length ? `Unresolved misconceptions: ${weak.join(", ")}.` : "",
    strong.length ? `Verified after correction: ${strong.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const pretty = (code: string) => code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
