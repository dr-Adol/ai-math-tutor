import OpenAI from "openai";
import { NextResponse } from "next/server";
import { SYSTEM_PROMPT, TUTOR_REPLY_SCHEMA, buildContextBlock } from "@/lib/prompt";
import { describeReport, verifyStudentMessage } from "@/lib/verifier";
import { isGoodFollowUp, leaksAnswer, reconcile, templateProblem } from "@/lib/guardrails";
import { rateLimit } from "@/lib/rateLimit";
import type { ChatTurn, ExerciseContext, TutorReply, TutorResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_TURNS = 20;
const MAX_CHARS = 1500;

let client: OpenAI | null = null;
function openai() {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("Server is missing OPENAI_API_KEY"), { status: 500 });
  client ??= new OpenAI({ timeout: 45_000, maxRetries: 1 });
  return client;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const parsed = parseBody(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { exercise, messages, learnerSummary } = parsed;

  // 1. Deterministic check of what the student just wrote
  const verifier = verifyStudentMessage(exercise.problem, messages.at(-1)!.content);

  try {
    // 2. Pedagogical reply from the model, in a strict JSON shape
    const base: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: buildContextBlock(exercise, describeReport(verifier), learnerSummary) },
      ...messages,
    ];
    let reply = await ask(base);

    // 3a. Never reveal the answer of an unsolved problem: one rewrite attempt, then a safe fallback
    const solvedNow = verifier.steps.some((s) => s.equivalent && s.isFinalAnswer);
    if (!solvedNow && leaksAnswer(reply.message, exercise.problem)) {
      reply = await ask([
        ...base,
        { role: "assistant", content: JSON.stringify(reply) },
        { role: "system", content: "Your reply revealed the final answer. Rewrite it so it guides with a question and does NOT state the value of the variable." },
      ]);
      if (leaksAnswer(reply.message, exercise.problem)) {
        reply.message = "Let's not jump to the answer. Look at your last step: which rule did you use there, and does it apply to every term?";
      }
    }

    // 3b. Reconcile with the verifier; regenerate the follow-up problem if needed
    const result = reconcile(reply, verifier, exercise);
    reply = result.reply;
    if (result.needsFollowUp) reply.follow_up_problem = await generateFollowUp(exercise);

    const res: TutorResponse = { reply, verifier };
    return NextResponse.json(res);
  } catch (err: any) {
    console.error("[tutor]", err?.status, err?.message);
    const status = err?.status === 429 ? 429 : 502;
    const error = err?.status === 429 ? "The AI service is busy. Try again in a moment." : err?.message?.includes("OPENAI_API_KEY") ? err.message : "The tutor could not answer. Try again.";
    return NextResponse.json({ error }, { status });
  }
}

async function ask(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<TutorReply> {
  // No temperature: newer reasoning models only accept the default.
  const completion = await openai().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_schema", json_schema: TUTOR_REPLY_SCHEMA as any },
    messages,
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty model response");
  return JSON.parse(raw) as TutorReply;
}

/** Focused second call when the model's follow-up was missing or not a well-posed equation. */
async function generateFollowUp(ex: ExerciseContext): Promise<string> {
  const target = ex.mistakesSoFar.map((m) => `${m.type}: ${m.description}`).join("; ") || "a mistake in this problem";
  try {
    const c = await openai().chat.completions.create({
      model: MODEL,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "follow_up",
          strict: true,
          schema: { type: "object", additionalProperties: false, required: ["problem"], properties: { problem: { type: "string" } } },
        },
      },
      messages: [
        {
          role: "user",
          content: `A student solved "${ex.problem}" after making this mistake: ${target}.
Write ONE new linear equation in x that checks the same skill with different numbers and a slightly different structure.
It must have a unique integer solution. Return only {"problem": "..."} using plain ASCII math like -2(x - 5) = 3x + 5.`,
        },
      ],
    });
    const p = JSON.parse(c.choices[0]?.message?.content ?? "{}").problem as string;
    if (isGoodFollowUp(p, ex.problem)) return p;
  } catch {}
  return templateProblem();
}

/** Validate and sanitise the request body. Roles are restricted to user/assistant. */
function parseBody(b: any): { exercise: ExerciseContext; messages: ChatTurn[]; learnerSummary?: string } | null {
  if (!b || typeof b !== "object") return null;
  const e = b.exercise;
  if (!e || typeof e.problem !== "string" || !e.problem.trim() || e.problem.length > 120) return null;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;
  const messages: ChatTurn[] = b.messages
    .slice(-MAX_TURNS)
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (messages.at(-1)?.role !== "user") return null;
  const mistakes = Array.isArray(e.mistakesSoFar) ? e.mistakesSoFar.slice(-10) : [];
  return {
    exercise: {
      problem: e.problem.trim(),
      origin: e.origin === "follow_up" ? "follow_up" : "assigned",
      targetSkill: typeof e.targetSkill === "string" ? e.targetSkill.slice(0, 60) : null,
      mistakesSoFar: mistakes
        .filter((m: any) => typeof m?.type === "string")
        .map((m: any) => ({ type: m.type.slice(0, 60), description: String(m.description ?? "").slice(0, 300) })),
      hintLevel: Math.min(4, Math.max(0, Number(e.hintLevel) || 0)),
      consecutiveErrors: Math.min(20, Math.max(0, Number(e.consecutiveErrors) || 0)),
    },
    messages,
    learnerSummary: typeof b.learnerSummary === "string" ? b.learnerSummary.slice(0, 600) : undefined,
  };
}
