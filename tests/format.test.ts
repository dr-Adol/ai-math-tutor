import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSystemMessages, plainMath } from "../lib/format.ts";

test("all system messages are merged into one leading message, order of the rest kept", () => {
  const out = mergeSystemMessages([
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "system", content: "C" },
    { role: "user", content: "u2" },
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "A\n\nB\n\nC" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ]);
});

test("LaTeX is converted to plain text", () => {
  assert.equal(plainMath("Let's solve for $x$. What is $3 \\cdot 4$?"), "Let's solve for x. What is 3 · 4?");
  assert.equal(plainMath("Use \\(a(b + c) = ab + ac\\)"), "Use a(b + c) = ab + ac");
  assert.equal(plainMath("$$\\frac{21}{3}$$"), "(21)/(3)");
  assert.equal(plainMath("No math here."), "No math here.");
});
