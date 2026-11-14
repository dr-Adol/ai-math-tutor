import OpenAI from "openai";
import { NextResponse } from "next/server";
import { SYSTEM_PROMPT, TUTOR_REPLY_SCHEMA, buildContextBlock } from "@/lib/prompt";
import { describeReport, verifyStudentMessage } from "@/lib/verifier";
import { isGoodFollowUp, leaksAnswer, reconcile, templateProblem } from "@/lib/guardrails";
import { rateLimit } from "@/lib/rateLimit";
import { mergeSystemMessages, plainMath } from "@/lib/format";
import type { ChatTurn, ExerciseContext, TutorReply, TutorResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_TURNS = 20;
const MAX_CHARS = 1500;

let client: OpenAI | null = null;
function openai() {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("Server is missing OPENAI_API_KEY"), { status: 500 });
  client ??= new OpenAI({ timeout: 20_000, maxRetries: 1 }); // stays within the 60 s function limit
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
      try {
        reply = await ask([
          ...base,
          { role: "assistant", content: JSON.stringify(reply) },
          { role: "user", content: "[Instruction from the tutoring system, not from the student] Your previous reply revealed the final answer. Rewrite it so it guides with a question and does NOT state the value of the variable." },
        ]);
      } catch (err: any) {
        console.warn("[tutor] answer-leak rewrite failed, using safe fallback:", err?.status, err?.message);
      }
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
    console.error("[tutor]", err?.status, err?.code, err?.message);
    const { status, error } = describeError(err);
    return NextResponse.json({ error }, { status });
  }
}

/** Map OpenAI / config errors to a clear message for the person running the demo. */
function describeError(err: any): { status: number; error: string } {
  const code = err?.code ?? err?.error?.code;
  if (err?.message?.includes("OPENAI_API_KEY")) return { status: 500, error: err.message };
  if (code === "insufficient_quota") return { status: 503, error: "The OpenAI account has no credits left. Add billing at platform.openai.com/settings/organization/billing." };
  if (err?.status === 401) return { status: 503, error: "The OpenAI API key is invalid. Check OPENAI_API_KEY in the deployment settings." };
  if (err?.status === 404 || code === "model_not_found") return { status: 503, error: `The model "${MODEL}" is not available for this OpenAI account. Set OPENAI_MODEL to a model you have access to.` };
  if (err?.status === 429) return { status: 429, error: "The AI service is busy. Try again in a moment." };
  const overloaded = err?.status === 500 || err?.status === 503 || err?.status === 504 || /timed? ?out|overloaded|unavailable/i.test(`${err?.name} ${err?.message}`);
  if (overloaded) return { status: 503, error: "The AI model is overloaded right now. Try again in a moment." };
  return { status: 502, error: "The tutor could not answer. Try again." };
}

/** Set once a provider rejects strict JSON schemas, so later calls go straight to JSON mode. */
// Gemini's OpenAI-compatible endpoint is known to reject strict schemas: skip the wasted first call.
let schemaUnsupported = /generativelanguage\.googleapis\.com/.test(process.env.OPENAI_BASE_URL ?? "");

/**
 * Tutoring turns need speed more than deep thinking. Ask reasoning models for low effort
 * (OPENAI_REASONING_EFFORT, default "low"; set it to "" to never send it). If a model rejects
 * the parameter, stop sending it.
 */
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT ?? "low";
let effortUnsupported = REASONING_EFFORT === "";

async function complete(input: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) {
  const params = { ...input, messages: mergeSystemMessages(input.messages) };
  if (!effortUnsupported) {
    try {
      return await openai().chat.completions.create({ ...params, reasoning_effort: REASONING_EFFORT as any });
    } catch (err: any) {
      if (err?.status !== 400 || !/reasoning/i.test(err?.message ?? "")) throw err;
      console.warn("[tutor] model rejected reasoning_effort, not sending it again:", err?.message);
      effortUnsupported = true;
    }
  }
  return openai().chat.completions.create(params);
}

/**
 * Works with OpenAI and with OpenAI-compatible providers (e.g. Google Gemini via OPENAI_BASE_URL).
 * Prefers strict Structured Outputs; if the provider rejects the schema (HTTP 400),
 * falls back to plain JSON mode with the schema described in the prompt.
 */
async function ask(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<TutorReply> {
  // No temperature: newer reasoning models only accept the default.
  if (!schemaUnsupported) {
    try {
      const completion = await complete({
        model: MODEL,
        response_format: { type: "json_schema", json_schema: TUTOR_REPLY_SCHEMA as any },
        messages,
      });
      return parseReply(completion.choices[0]?.message?.content);
    } catch (err: any) {
      if (err?.status !== 400) throw err;
      console.warn("[tutor] provider rejected json_schema, switching to JSON mode:", err?.message);
      schemaUnsupported = true;
    }
  }
  const completion = await complete({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      ...messages,
      { role: "system", content: `Reply with ONLY one JSON object matching this JSON schema, no other text:\n${JSON.stringify(TUTOR_REPLY_SCHEMA.schema)}` },
    ],
  });
  return parseReply(completion.choices[0]?.message?.content);
}

/** Parse the model's JSON (tolerating a code fence) and fill missing fields with safe defaults. */
function parseReply(raw: string | null | undefined): TutorReply {
  if (!raw) throw new Error("Empty model response");
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    throw new Error("Model returned invalid JSON");
  }
  if (typeof r?.message !== "string" || !r.message.trim()) throw new Error("Model reply has no message");
  const statuses = ["correct_step", "error", "final_correct", "question", "other"];
  return {
    message: plainMath(r.message),
    status: statuses.includes(r.status) ? r.status : "other",
    error_type: typeof r.error_type === "string" && r.error_type ? r.error_type : null,
    error_description: typeof r.error_description === "string" && r.error_description ? r.error_description : null,
    skill: typeof r.skill === "string" && r.skill ? r.skill : "linear_equations",
    hint_level: Number(r.hint_level) || 0,
    problem_solved: r.problem_solved === true,
    follow_up_problem: typeof r.follow_up_problem === "string" && r.follow_up_problem ? r.follow_up_problem : null,
  };
}

/** Focused second call when the model's follow-up was missing or not a well-posed equation. */
async function generateFollowUp(ex: ExerciseContext): Promise<string> {
  const target = ex.mistakesSoFar.map((m) => `${m.type}: ${m.description}`).join("; ") || "a mistake in this problem";
  try {
    const c = await complete({
      model: MODEL,
      response_format: schemaUnsupported
        ? { type: "json_object" }
        : {
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
    const raw = (c.choices[0]?.message?.content ?? "{}").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const p = JSON.parse(raw).problem as string;
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
