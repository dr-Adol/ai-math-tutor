# Uchitel — AI Math Tutor (prototype)

An interactive AI mathematics tutor inspired by the Soviet school of mathematics education:
every transformation must be justified, mistakes are analysed ("работа над ошибками" — *work on mistakes*),
and understanding is consolidated with a similar problem ("закрепление").

## Quick start

```bash
cp .env.example .env.local      # put your OPENAI_API_KEY here
npm install
npm run dev                     # http://localhost:3000
npm test                        # unit tests: verifier, guardrails, progress (Node 22.6+)
npm run eval                    # behaviour eval against the real model (needs the dev server running)
```

Deploy: push to GitHub → import in Vercel → set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, `RATE_LIMIT_PER_MINUTE`). No database needed.
Default model: `gpt-5.4-mini`; any Chat Completions model with Structured Outputs works.

**Free option (Google Gemini).** The app uses the OpenAI SDK, so any OpenAI-compatible provider works without code
changes. For Gemini's free tier set `OPENAI_API_KEY` to a key from [Google AI Studio](https://aistudio.google.com/apikey),
`OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/` and `OPENAI_MODEL=gemini-3.5-flash`.
If a provider rejects strict JSON schemas, the server falls back to JSON mode automatically.

## Test scenario

The app opens on `3(x + 4) = 2x + 19`. Click **"Try the test scenario"** (sends `3x + 4 = 2x + 19`):

1. The symbolic verifier marks the line ✗ — it gives x = 15, while the original equation has x = 7.
2. The AI diagnoses the *reasoning* error (distributive property applied only to the first term) and asks a
   leading question instead of giving the answer. Help escalates gradually: question → rule → analogous example → single step.
3. The student fixes the step (`3x + 12 = 2x + 19`), then reaches `x = 7` — both verified ✓.
4. Because the solved exercise contained a mistake, the tutor generates a **new similar problem**
   (e.g. `-2(x - 5) = 3x + 5`) targeting the same misconception.
5. Solving it with no mistakes marks the skill as **fixed ✓** in the progress panel.

## Technical approach

```
Browser (Next.js / React)                      Server (Next.js route /api/tutor)
─────────────────────────                      ────────────────────────────────────────────
chat UI + progress reducer      ── POST ──▶     1. Verifier (mathjs): is each equation the student
(localStorage persistence)                         wrote equivalent to the original?  ← ground truth
                                                2. OpenAI Chat Completions + Structured Outputs:
                                                   pedagogical system prompt + context (problem,
                                                   mistakes so far, hint level, learner summary,
                                                   verifier report) → strict JSON reply
                                ◀── JSON ──     3. Guardrails: reconcile model vs verifier,
                                                   validate/regenerate the follow-up problem
```

**Hybrid "neuro-symbolic" design.** LLMs explain well but can be wrong about arithmetic. So correctness is
decided deterministically: every equation in the student's message is reduced to linear form `a·x + b = 0`
and its solution is compared with the original's. A valid transformation must preserve the solution set.
The model receives this report as ground truth and focuses on *why* the step is wrong (the misconception).

**Structured outputs, not scripted replies.** The model returns JSON (`lib/prompt.ts`):
`message, status, error_type, error_description, skill, hint_level, problem_solved, follow_up_problem`.
Nothing in the tutor's text is hardcoded; the JSON drives UI state and progress tracking.

**Guardrails** (`lib/guardrails.ts`, unit-tested)
- If the verifier finds an invalid line, the turn is recorded as an error even if the model missed it.
- `problem_solved` is only accepted when the verifier confirms the final answer.
- **No answer leaks:** if the tutor's message states the value of x for an unsolved problem, the model is asked
  to rewrite it once; if it leaks again, a safe guiding message is used instead.
- **Hint escalation is earned:** the client counts consecutive wrong attempts on a step; the full step
  (level 4) is allowed only after 3.
- The follow-up problem must be a new linear equation with a unique integer root; otherwise a focused
  second call regenerates it, with a deterministic template generator as the last resort.

**Security of the public demo** — the API key stays on the server; request bodies are validated and
truncated, chat roles are restricted to `user`/`assistant` (no client-injected system prompts), and
`/api/tutor` is rate-limited per IP.

**Testing** — `npm test` covers the verifier, guardrails and the progress reducer (including the full test
scenario). `npm run eval` sends six recorded student mistakes to the real model and checks the *behaviour*:
the error is detected and named, the answer is not revealed, a guiding question is asked, a valid follow-up
problem is produced.

**Progress tracking** (`lib/progress.ts`) — exercises (assigned / follow-up), mistakes with the student's
wrong line and diagnosis, hint levels, skills with "verified after correction" status, accuracy.
A compact learner summary is sent with every request so explanations are personalised.

| Path | What |
|---|---|
| `app/page.tsx` | Chat UI, lesson stepper, progress panels |
| `app/api/tutor/route.ts` | OpenAI call, guardrails, follow-up generation |
| `lib/verifier.ts` | Equation extraction + symbolic equivalence check |
| `lib/prompt.ts` | Teaching method (system prompt) + JSON schema |
| `lib/guardrails.ts` | Model ↔ verifier reconciliation, answer-leak check, follow-up validation |
| `lib/progress.ts` | Progress model, reducer, learner summary |
| `lib/rateLimit.ts` | Per-IP rate limit for the API route |
| `tests/` | Unit tests incl. the test scenario |
| `scripts/eval.mjs` | Behaviour eval against the real model |
| `demo/uchitel-demo.html` | Single-file version of the same tutor (runs on Claude inside claude.ai) |

## Scaling to Web, iOS and Android

1. **Backend as the product core.** Move `/api/tutor` into a standalone service (Node/TypeScript, same code)
   with a versioned REST/streaming API. Add auth (Supabase/Auth0/Firebase), Postgres for users, exercises,
   attempts and mistake events (the current reducer becomes server-side), Redis for rate limits and sessions.
   Stream tokens (SSE) for faster perceived response.
2. **Shared client logic.** The domain code (`verifier`, `progress`, types, API client) is plain TypeScript —
   publish it as an internal package used by every client.
3. **Web:** this Next.js app (SSR for landing/SEO, PWA for offline practice).
   **iOS + Android:** React Native / Expo reusing the shared package and the same API — one team, ~80% shared code,
   native math keyboard and handwriting input (Apple Pencil / stylus → OCR such as Mathpix) as platform extras.
   (If a fully native look is a requirement: SwiftUI + Kotlin clients over the same API.)
4. **Content & pedagogy at scale.** A curriculum graph of skills (Kiselyov-style topic progression), a problem bank
   with parameterised generators verified by the symbolic engine, spaced repetition of weak skills,
   teacher/parent dashboards. Extend the verifier beyond linear equations with a CAS (SymPy service).
5. **Quality & cost.** Model routing (small model for routine turns, larger for diagnosis), prompt/response caching,
   an evaluation suite of recorded student errors to regression-test prompts before each release,
   analytics on which misconceptions are most common, observability (OpenTelemetry), and child-safety/privacy
   compliance (COPPA/GDPR-K).
