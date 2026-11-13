// Behaviour eval against the REAL model: checks the tutor's teaching behaviour on recorded student mistakes.
// Usage: npm run dev (in another terminal), then: npm run eval   [EVAL_URL=http://localhost:3000]
const URL = (process.env.EVAL_URL || "http://localhost:3000") + "/api/tutor";

const ex = (problem, mistakesSoFar = []) => ({ problem, origin: "assigned", mistakesSoFar, hintLevel: 0, consecutiveErrors: mistakesSoFar.length });
const leak = (msg, value) => new RegExp(`\\bx\\s*=\\s*${value}\\b|\\b${value}\\s*=\\s*x\\b`).test(msg);

const CASES = [
  {
    name: "Test scenario: distributive property applied to x only",
    body: { exercise: ex("3(x + 4) = 2x + 19"), messages: [{ role: "user", content: "3x + 4 = 2x + 19" }] },
    check: (r) => [
      [r.status === "error", "status is error"],
      [/distribut|bracket|parenthes|4/i.test(r.error_type + " " + r.error_description + " " + r.message), "names the bracket/distribution issue"],
      [!leak(r.message, 7), "does not reveal x = 7"],
      [/\?/.test(r.message), "asks a guiding question"],
    ],
  },
  {
    name: "Sign error with a negative multiplier",
    body: { exercise: ex("-4(x - 3) = 2x - 6"), messages: [{ role: "user", content: "-4x - 12 = 2x - 6" }] },
    check: (r) => [
      [r.status === "error", "status is error"],
      [/sign|negative|minus/i.test(r.error_type + " " + r.error_description + " " + r.message), "identifies the sign problem"],
      [!leak(r.message, 3), "does not reveal x = 3"],
    ],
  },
  {
    name: "Moving a term without changing its sign",
    body: {
      exercise: ex("3(x + 4) = 2x + 19"),
      messages: [
        { role: "user", content: "3x + 12 = 2x + 19" },
        { role: "assistant", content: "Correct, the bracket is expanded properly. What's next?" },
        { role: "user", content: "3x + 2x = 19 - 12" },
      ],
    },
    check: (r) => [
      [r.status === "error", "status is error"],
      [!leak(r.message, 7), "does not reveal x = 7"],
    ],
  },
  {
    name: "Student asks for the answer",
    body: { exercise: ex("3(x + 4) = 2x + 19"), messages: [{ role: "user", content: "Just tell me what x is, please." }] },
    check: (r) => [
      [!leak(r.message, 7), "does not reveal x = 7"],
      [r.problem_solved === false, "problem not marked solved"],
    ],
  },
  {
    name: "Correct step is confirmed",
    body: { exercise: ex("3(x + 4) = 2x + 19"), messages: [{ role: "user", content: "3x + 12 = 2x + 19 (distributive property)" }] },
    check: (r) => [
      [r.status === "correct_step", "status is correct_step"],
      [r.error_type === null, "no error recorded"],
    ],
  },
  {
    name: "Solved after a mistake -> similar follow-up problem",
    body: {
      exercise: ex("3(x + 4) = 2x + 19", [{ type: "distributive_property_partial", description: "Multiplied only x by 3." }]),
      messages: [
        { role: "user", content: "3x + 4 = 2x + 19" },
        { role: "assistant", content: "Look at the bracket: what happens to the 4 when you multiply by 3?" },
        { role: "user", content: "Oh, 3x + 12 = 2x + 19, so x = 7" },
      ],
    },
    check: (r) => [
      [r.problem_solved === true, "problem solved"],
      [typeof r.follow_up_problem === "string" && /\(/.test(r.follow_up_problem), "follow-up problem has brackets (same skill)"],
    ],
  },
];

let passed = 0, total = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.body) });
  const data = await res.json();
  if (!res.ok) { console.log(`✗ ${c.name}: HTTP ${res.status} ${data.error}`); total++; continue; }
  const r = data.reply;
  const checks = c.check(r);
  const ok = checks.every(([v]) => v);
  total++; if (ok) passed++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}  (${Date.now() - t0} ms)`);
  for (const [v, label] of checks) console.log(`    ${v ? "ok  " : "FAIL"} ${label}`);
  console.log(`    tutor: ${r.message.replace(/\s+/g, " ").slice(0, 220)}`);
  if (r.follow_up_problem) console.log(`    follow-up: ${r.follow_up_problem}`);
}
console.log(`\n${passed}/${total} scenarios passed`);
process.exit(passed === total ? 0 : 1);
