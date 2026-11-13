/**
 * Provider-compatibility helpers (pure functions, unit-tested).
 */

/**
 * Some OpenAI-compatible providers (e.g. Gemini) keep only one system message.
 * Merge every system message into a single leading one so no instructions or context are lost.
 */
export function mergeSystemMessages<T extends { role: string; content?: unknown }>(messages: T[]): T[] {
  const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return system ? [{ role: "system", content: system } as T, ...rest] : rest;
}

/** Some models answer with LaTeX ($x$, \\cdot). The chat shows plain text, so convert it. */
export function plainMath(text: string): string {
  return text
    .replace(/\$\$?([^$]+?)\$\$?/g, "$1")
    .replace(/\\[()[\]]/g, "")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1)/($2)")
    .replace(/\\(?:text|mathrm)\{([^}]*)\}/g, "$1")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\(?:left|right)/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

