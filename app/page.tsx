"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatTurn, TutorReply, TutorResponse } from "@/lib/types";
import type { VerifierReport } from "@/lib/verifier";
import { analyzeEquation, detectVariable, verifyStudentMessage } from "@/lib/verifier";
import {
  applyReply, emptyProgress, learnerSummary, loadProgress, newExercise, pretty, saveProgress, stats,
  type Exercise, type Progress,
} from "@/lib/progress";

type FeedItem =
  | { kind: "exercise"; exerciseId: string }
  | { kind: "msg"; exerciseId: string; role: "user" | "assistant"; content: string; reply?: TutorReply; verifier?: VerifierReport };

const PRESETS = ["3(x + 4) = 2x + 19", "5(x - 2) = 3x + 6", "-4(x - 3) = 2x - 6", "7 - 2(x + 1) = x - 4"];
const FEED_KEY = "ai-math-tutor:feed:v1";

export default function Page() {
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  // load persisted state (or start the test scenario)
  useEffect(() => {
    const p = loadProgress();
    let f: FeedItem[] = [];
    try { f = JSON.parse(localStorage.getItem(FEED_KEY) || "[]"); } catch {}
    const last = [...p.exercises].reverse().find((e) => e.status === "in_progress") ?? p.exercises.at(-1);
    if (last && f.length) {
      setProgress(p); setFeed(f); setCurrentId(last.id);
    } else {
      startExercise(PRESETS[0], emptyProgress(), []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!currentId) return;
    saveProgress(progress);
    try { localStorage.setItem(FEED_KEY, JSON.stringify(feed.slice(-300))); } catch {}
  }, [progress, feed, currentId]);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [feed, busy]);

  const current = progress.exercises.find((e) => e.id === currentId) ?? null;
  const st = useMemo(() => stats(progress), [progress]);

  function startExercise(problem: string, base = progress, baseFeed = feed) {
    const ex = newExercise(problem);
    setProgress({ ...base, exercises: [...base.exercises, ex] });
    setFeed([...baseFeed, { kind: "exercise", exerciseId: ex.id }]);
    setCurrentId(ex.id);
    setError(null);
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || !current || busy) return;
    setInput(""); setError(null);
    // instant, local symbolic check (the server re-checks the same thing)
    const userItem: FeedItem = { kind: "msg", exerciseId: current.id, role: "user", content, verifier: verifyStudentMessage(current.problem, content) };
    const nextFeed = [...feed, userItem];
    setFeed(nextFeed);
    setBusy(true);

    const turns: ChatTurn[] = nextFeed
      .filter((i): i is Extract<FeedItem, { kind: "msg" }> => i.kind === "msg" && i.exerciseId === current.id)
      .map((i) => ({ role: i.role, content: i.role === "assistant" ? i.reply?.message ?? i.content : i.content }));

    try {
      const res = await fetch("/api/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exercise: {
            problem: current.problem, origin: current.origin, targetSkill: current.targetSkill,
            mistakesSoFar: current.mistakes.map((m) => ({ type: m.type, description: m.description })),
            hintLevel: current.hintLevel,
            consecutiveErrors: current.consecutiveErrors ?? 0,
          },
          messages: turns,
          learnerSummary: learnerSummary(progress),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      const { reply } = data as TutorResponse;
      setFeed((f) => [...f, { kind: "msg", exerciseId: current.id, role: "assistant", content: reply.message, reply }]);
      const { progress: np, followUp } = applyReply(progress, current.id, reply, content);
      setProgress(np);
      if (followUp) {
        setFeed((f) => [...f, { kind: "exercise", exerciseId: followUp.id }]);
        setCurrentId(followUp.id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!confirm("Reset all progress?")) return;
    localStorage.removeItem(FEED_KEY);
    startExercise(PRESETS[0], emptyProgress(), []);
  }

  const solved = current?.status === "solved";
  const isScenario = current?.problem === PRESETS[0] && !feed.some((i) => i.kind === "msg" && i.exerciseId === current?.id);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">Uchitel<span>.</span></div>
          <div className="brand-sub">AI math tutor · the Soviet method: justify every step, work on your mistakes</div>
        </div>
        <button className="ghost" onClick={() => setPicker(true)}>New problem</button>
      </header>

      <div className="layout">
        <main className="notebook">
          <div className="problem-bar">
            <span className="label">Solve</span>
            <span className="eq">{current?.problem}</span>
            {current?.origin === "follow_up" && <span className="pill green">Practice · verifies {pretty(current.targetSkill ?? "skill")}</span>}
            {solved && <span className="pill green">Solved</span>}
            {!solved && current && current.mistakes.length > 0 && <span className="pill red">{current.mistakes.length} mistake{current.mistakes.length > 1 ? "s" : ""}</span>}
          </div>

          <div className="feed" ref={feedRef} aria-live="polite">
            {feed.map((item, idx) => {
              if (item.kind === "exercise") {
                const ex = progress.exercises.find((e) => e.id === item.exerciseId);
                if (!ex) return null;
                return (
                  <div key={idx} className={`ex-card ${ex.origin === "follow_up" ? "follow" : ""}`}>
                    <div className="kicker">{ex.origin === "follow_up" ? "Consolidation · similar problem" : "New exercise"}</div>
                    <div className="eq">{ex.problem}</div>
                    <p>
                      {ex.origin === "follow_up"
                        ? "You fixed your mistake — now show that you've got it. Solve this one step by step."
                        : "Solve step by step. Write one transformation per message and say which rule you used."}
                    </p>
                  </div>
                );
              }
              if (item.role === "user") {
                return (
                  <div key={idx} className="msg student">
                    <div className="who">You</div>
                    <div className="bubble">{item.content}</div>
                    {item.verifier && item.verifier.steps.length > 0 && (
                      <div className="checks">
                        {item.verifier.steps.map((s, i) => (
                          <span key={i} className={`check ${s.equivalent ? "good" : "bad"}`} title={s.equivalent ? "Equivalent to the original equation" : "This line changes the solution — something went wrong"}>
                            {s.equivalent ? "✓" : "✗"} {s.equation}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }
              const r = item.reply;
              return (
                <div key={idx} className={`msg tutor ${r && r.status !== "error" ? "ok" : ""}`}>
                  <div className="who">Tutor</div>
                  <div className="bubble">{item.content}</div>
                  {r && (
                    <div className="tags">
                      {r.status === "error" && r.error_type && <span className="pill red">Mistake: {pretty(r.error_type)}</span>}
                      {r.status === "correct_step" && <span className="pill green">Correct step</span>}
                      {r.problem_solved && <span className="pill green">Problem solved</span>}
                      {r.hint_level > 0 && <span className="pill amber">Hint level {r.hint_level}/4</span>}
                    </div>
                  )}
                </div>
              );
            })}
            {busy && <div className="thinking">The tutor is checking your work…</div>}
            {error && <div className="error-note">Error: {error}</div>}
          </div>

          <div className="composer">
            <div className="quick">
              {isScenario && <button className="chip accent" onClick={() => send("3x + 4 = 2x + 19")}>Try the test scenario: 3x + 4 = 2x + 19</button>}
              {!solved && <button className="chip" onClick={() => send("I'm stuck. Can you give me a hint?")} disabled={busy}>I'm stuck</button>}
              {!solved && <button className="chip" onClick={() => send("Why is that?")} disabled={busy}>Why?</button>}
              {solved && <button className="chip accent" onClick={() => setPicker(true)}>Next problem →</button>}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <textarea
                aria-label="Your next step"
                value={input}
                placeholder={solved ? "Problem solved — pick a new one, or ask a question" : "Write your next step, e.g. 3x + 12 = 2x + 19"}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
                rows={1}
              />
              <button className="send" disabled={busy || !input.trim()}>Send</button>
            </form>
            <div className="hint">Every equation you write is checked by a symbolic math engine; the AI explains <i>why</i>.</div>
          </div>
        </main>

        <Sidebar progress={progress} current={current} st={st} onReset={reset} />
      </div>

      {picker && <ProblemPicker onClose={() => setPicker(false)} onPick={(p) => { setPicker(false); startExercise(p); }} />}
    </div>
  );
}

function phaseIndex(ex: Exercise | null): number {
  if (!ex) return 0;
  if (ex.origin === "assigned") {
    if (ex.status === "solved") return ex.mistakes.length ? 2 : 4;
    return ex.mistakes.length ? 1 : 0;
  }
  return ex.status === "solved" ? 4 : 2;
}

function Sidebar({ progress, current, st, onReset }: { progress: Progress; current: Exercise | null; st: ReturnType<typeof stats>; onReset: () => void }) {
  const phase = phaseIndex(current);
  const steps = ["Solve the problem", "Find & fix the mistake", "Verify on a similar problem", "Skill confirmed"];
  const mistakes = progress.exercises.flatMap((e) => e.mistakes.map((m) => ({ ...m, problem: e.problem }))).reverse();
  const skills = Object.entries(progress.skills);

  return (
    <aside className="side">
      <section className="panel">
        <h3>Current lesson</h3>
        <div className="stepper">
          {steps.map((s, i) => (
            <div key={s} className={`step ${i < phase ? "done" : i === phase ? "active" : ""}`}>
              <span className="dot">{i < phase ? "✓" : i + 1}</span>{s}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Progress</h3>
        <div className="stats">
          <div className="stat"><b>{st.completed}</b><span>exercises solved</span></div>
          <div className="stat"><b>{st.mistakes}</b><span>mistakes found</span></div>
          <div className="stat"><b>{st.completed ? `${st.accuracy}%` : "—"}</b><span>solved with no mistakes</span></div>
          <div className="stat"><b>{st.verifiedSkills}/{st.totalSkills}</b><span>weak spots fixed</span></div>
        </div>
      </section>

      <section className="panel">
        <h3>Work on mistakes <small>rabota nad oshibkami</small></h3>
        {mistakes.length === 0 ? <div className="empty">No mistakes yet.</div> : (
          <ul className="list">
            {mistakes.slice(0, 6).map((m, i) => (
              <li key={i}>
                <div className="t">{pretty(m.type)}</div>
                {m.studentLine && <div className="line">{m.studentLine}</div>}
                <div>{m.description}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3>Skills</h3>
        {skills.length === 0 ? <div className="empty">Skills appear here once the tutor spots a weak point.</div> :
          skills.map(([k, s]) => (
            <div className="skill" key={k}>
              <span>{pretty(k)}</span>
              {s.verified ? <span className="pill green">Fixed ✓</span> : <span className="pill red">{s.mistakes} mistake{s.mistakes > 1 ? "s" : ""}</span>}
            </div>
          ))}
      </section>

      <section className="panel">
        <h3>Exercise history</h3>
        <ul className="list history">
          {[...progress.exercises].reverse().slice(0, 8).map((e) => (
            <li key={e.id} className={e.status === "solved" ? "solved" : ""}>
              <span style={{ fontFamily: "var(--serif)" }}>{e.problem}</span>{" "}
              <span className="empty">· {e.status === "solved" ? "solved" : "in progress"}{e.mistakes.length ? ` · ${e.mistakes.length} mistake(s)` : ""}{e.origin === "follow_up" ? " · practice" : ""}</span>
            </li>
          ))}
        </ul>
      </section>
      <button className="reset" onClick={onReset}>Reset progress</button>
    </aside>
  );
}

function ProblemPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: string) => void }) {
  const [custom, setCustom] = useState("");
  const [err, setErr] = useState("");
  function submitCustom() {
    const a = analyzeEquation(custom, detectVariable(custom));
    if (a.kind !== "unique") { setErr("Please enter a linear equation with exactly one solution, e.g. 4(x - 1) = 2x + 6"); return; }
    onPick(custom.trim());
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Choose a problem</h2>
        <div className="presets">
          {PRESETS.map((p) => <button key={p} className="preset" onClick={() => onPick(p)}>{p}</button>)}
        </div>
        <input placeholder="…or type your own, e.g. 4(x - 1) = 2x + 6" value={custom} onChange={(e) => { setCustom(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submitCustom()} />
        {err && <div className="small-err">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submitCustom} disabled={!custom.trim()}>Start</button>
        </div>
      </div>
    </div>
  );
}
