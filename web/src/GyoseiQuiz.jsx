import React, { useState, useMemo, useEffect } from "react";
import { loadQuestions } from "./data/loadQuestions.js";
import { loadLocalHistory, recordAnswer, syncFromServer } from "./lib/history.js";
import { isSupabaseConfigured } from "./lib/supabase.js";

/**
 * 行政書士試験 問題集アプリ — UI（PWA / 永続化対応）
 * ------------------------------------------------------------------
 *  (1) 履歴を「累積」化 … 解くたびに attempts +1 / 正解で correct_count +1
 *  (2) 5肢択一 → ○×一問一答の変換器
 *  (3) 永続化 … IndexedDB に保存（localStorage は使わない）。
 *      Supabase 設定時は端末間で履歴を合算同期（送るのは question_id と集計のみ）。
 *
 * 問題データは loadQuestions() が読み込む。実過去問は public/data/questions.json に
 * 手動配置（.gitignore 済み）。無ければ自作サンプルで動作する。
 * ＊このファイルには過去問の本文を絶対に書かない（公開リポジトリ事故防止）。
 * ------------------------------------------------------------------
 */

const C = {
  bg: "#e9ecf1", paper: "#fbf9f3", ink: "#1c2c4c", inkSoft: "#56607e",
  line: "#d9d3c4", shu: "#c43d2b", shuSoft: "#f2ddd6",
};
const MINCHO = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP',serif";
const GOTHIC = "'Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif";

/* ═══════════ (2) 5肢択一 → ○×一問一答 変換器 ═══════════ */

function detectPolarity(stem) {
  if (/(誤っている|妥当でない|適切でない|正しくない|不適切|誤り)/.test(stem)) return "find_false";
  if (/(正しいもの|妥当なもの|適切なもの|妥当である|正しい記述)/.test(stem)) return "find_true";
  return null;
}
function isCombo(choices) {
  return Object.values(choices).some((t) => {
    const s = t.trim();
    return /^[アイウエオ][・･]/.test(s) || (s.length <= 8 && /[・]/.test(s));
  });
}
function toOX(q) {
  const pol = detectPolarity(q.stem);
  if (!pol || isCombo(q.choices)) return null;
  return Object.entries(q.choices).map(([n, statement]) => ({
    kind: "ox", id: `${q.id}-${n}`, parent: q.id,
    year: q.year, number: q.number, field: q.field, choiceNo: n,
    statement,
    isTrue: pol === "find_false" ? n !== q.answer : n === q.answer,
  }));
}
function buildDeck(questions, mode) {
  if (mode !== "ox") return questions.map((q) => ({ kind: q.type, ...q }));
  const deck = [];
  for (const q of questions) {
    if (q.type === "tantou5") {
      const ox = toOX(q);
      if (ox) { deck.push(...ox); continue; }
    }
    deck.push({ kind: q.type, ...q });
  }
  return deck;
}

/* ═══════════ 採点スタンプ ═══════════ */
function Stamp({ kind }) {
  const mark = kind === "maru" ? "○" : kind === "batsu" ? "×" : "△";
  return (
    <span className="inline-flex items-center justify-center rounded-full select-none stamp"
      style={{ width: 56, height: 56, color: C.shu, border: `3px solid ${C.shu}`,
        fontFamily: MINCHO, fontSize: 30, lineHeight: 1, fontWeight: 700 }}
      aria-label={kind === "maru" ? "正解" : kind === "batsu" ? "不正解" : "部分正解"}>
      {mark}
    </span>
  );
}

export default function GyoseiQuiz() {
  const [questions, setQuestions] = useState(null);
  const [source, setSource] = useState(null);
  const [synced, setSynced] = useState(false);

  const [mode, setMode] = useState("tantou5");
  const [idx, setIdx] = useState(0);
  const [history, setHistory] = useState({});
  const [picked, setPicked] = useState(null);
  const [blanks, setBlanks] = useState({});
  const [revealed, setRevealed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState(null);

  // 問題データの読み込み
  useEffect(() => {
    loadQuestions().then(({ questions, source }) => {
      setQuestions(questions);
      setSource(source);
    });
  }, []);

  // 履歴: まずローカル(IndexedDB)を即時反映 → 設定があればサーバー集約で上書き
  useEffect(() => {
    let alive = true;
    loadLocalHistory().then((h) => { if (alive) setHistory(h); });
    syncFromServer().then((h) => {
      if (alive && h) { setHistory(h); setSynced(true); }
    });
    return () => { alive = false; };
  }, []);

  const deck = useMemo(
    () => (questions ? buildDeck(questions, mode) : []),
    [questions, mode]
  );
  const entry = deck[idx];
  const rec = entry ? history[entry.id] : null;

  const totals = useMemo(() => {
    const vals = Object.values(history);
    return {
      seen: vals.length,
      attempts: vals.reduce((a, v) => a + v.attempts, 0),
      correct: vals.reduce((a, v) => a + v.correct_count, 0),
    };
  }, [history]);

  function recordHistory(id, correct, chosen) {
    // 楽観的に即時反映
    setHistory((h) => {
      const p = h[id] || { attempts: 0, correct_count: 0 };
      return {
        ...h,
        [id]: {
          attempts: p.attempts + 1,
          correct_count: p.correct_count + (correct === true ? 1 : 0),
          last_result: correct, last_chosen: chosen,
          updated_at: new Date().toISOString(),
        },
      };
    });
    // 永続化（IndexedDB）＋ サーバー送信キューへ。確定値で同期し直す。
    recordAnswer(id, correct, chosen).then((h) => setHistory(h)).catch(() => {});
  }

  function resetTransient() {
    setPicked(null); setBlanks({}); setRevealed(false);
    setSubmitted(false); setResult(null);
  }
  function go(delta) {
    const n = Math.min(Math.max(idx + delta, 0), deck.length - 1);
    setIdx(n); resetTransient();
  }
  function switchMode(m) { setMode(m); setIdx(0); resetTransient(); }

  function judge() {
    let correct = null, chosen = null, res = null;
    if (entry.type === "tantou5") {
      chosen = picked; correct = picked === entry.answer;
      res = correct ? "maru" : "batsu";
    } else if (entry.type === "tashi") {
      chosen = blanks;
      const ks = ["ア", "イ", "ウ", "エ"];
      const hit = ks.filter((k) => blanks[k] === entry.answer[k]).length;
      correct = hit === ks.length;
      res = correct ? "maru" : hit > 0 ? "sankaku" : "batsu";
    }
    setResult(res); setSubmitted(true);
    recordHistory(entry.id, correct, chosen);
  }
  function judgeOX(pick) {
    if (submitted) return;
    const correct = (pick === "○") === entry.isTrue;
    setPicked(pick); setResult(correct ? "maru" : "batsu"); setSubmitted(true);
    recordHistory(entry.id, correct, pick);
  }
  function selfGrade(g) {
    setResult(g); setSubmitted(true);
    recordHistory(entry.id, g === "maru", "self:" + g);
  }

  if (!questions) {
    return (
      <div style={{ background: C.bg, minHeight: "100%", fontFamily: GOTHIC, color: C.inkSoft,
        display: "flex", alignItems: "center", justifyContent: "center" }}>
        読み込み中…
      </div>
    );
  }

  const canSubmit =
    (entry.type === "tantou5" && picked) ||
    (entry.type === "tashi" && ["ア", "イ", "ウ", "エ"].every((k) => blanks[k]));

  const syncLabel = !isSupabaseConfigured
    ? "ローカル保存"
    : synced ? "同期済み" : "ローカル保存（同期待ち）";

  return (
    <div style={{ background: C.bg, minHeight: "100%", fontFamily: GOTHIC, color: C.ink }}>
      <style>{`
        @keyframes stampIn{0%{opacity:0;transform:scale(1.6) rotate(-12deg)}
          60%{opacity:1;transform:scale(.92) rotate(-12deg)}100%{transform:scale(1) rotate(-12deg)}}
        .stamp{animation:stampIn .28s ease-out;transform:rotate(-12deg)}
        @media (prefers-reduced-motion:reduce){.stamp{animation:none}}
        .opt:focus-visible{outline:2px solid ${C.ink};outline-offset:2px}
      `}</style>

      <div className="mx-auto" style={{ maxWidth: 760, padding: "20px 16px 56px" }}>
        <div className="flex items-center justify-between mb-4" style={{ gap: 8 }}>
          <div className="flex gap-1" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: 3, width: "fit-content" }}>
            {[["tantou5", "5肢択一"], ["ox", "○×一問一答"]].map(([m, lbl]) => (
              <button key={m} className="opt" onClick={() => switchMode(m)} style={{
                background: mode === m ? C.ink : "transparent", color: mode === m ? "#fff" : C.inkSoft,
                border: "none", borderRadius: 4, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{lbl}</button>
            ))}
          </div>
          <div className="flex items-center" style={{ gap: 8, fontSize: 11, color: C.inkSoft }}>
            {source === "sample" && (
              <span style={{ color: C.shu, border: `1px solid ${C.shu}`, borderRadius: 2, padding: "2px 6px" }}>サンプル問題</span>
            )}
            <span>{syncLabel}</span>
          </div>
        </div>

        <header className="flex items-end justify-between mb-4">
          <div>
            <div style={{ fontSize: 12, letterSpacing: 2, color: C.inkSoft }}>行政書士試験 過去問</div>
            <div style={{ fontFamily: MINCHO, fontSize: 22, fontWeight: 700 }}>
              {entry.year}年度・問題{entry.number}
              {entry.kind === "ox" && <span style={{ fontSize: 15, color: C.shu }}>　肢{entry.choiceNo}</span>}
            </div>
          </div>
          <div className="text-right" style={{ fontSize: 12, color: C.inkSoft }}>
            <div>{idx + 1} / {deck.length}</div>
            <div>延べ{totals.attempts}回 ・ 正答{totals.correct}</div>
          </div>
        </header>

        <div style={{ height: 3, background: C.line, borderRadius: 2 }} className="mb-5">
          <div style={{ height: "100%", width: `${((idx + 1) / deck.length) * 100}%`, background: C.shu, borderRadius: 2, transition: "width .3s" }} />
        </div>

        <article style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 4, boxShadow: "0 1px 0 rgba(0,0,0,.03)", padding: "22px 22px 26px" }}>
          <div className="flex items-center justify-between mb-3">
            <span className="inline-block" style={{ fontSize: 11, letterSpacing: 1, color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 2, padding: "2px 8px" }}>
              {entry.field} ・ {entry.kind === "ox" ? "○×" : labelOf(entry.type)}
            </span>
            {rec && (
              <span style={{ fontSize: 11, color: C.inkSoft }}>
                この問題：{rec.attempts}回中 <b style={{ color: C.ink }}>{rec.correct_count}</b> 正解
              </span>
            )}
          </div>

          {entry.kind === "ox" ? (
            <OXItem entry={entry} picked={picked} submitted={submitted} onPick={judgeOX} />
          ) : (
            <>
              <p style={{ fontFamily: MINCHO, fontSize: 16, lineHeight: 1.9, margin: "0 0 18px", whiteSpace: "pre-wrap" }}>{entry.stem}</p>
              {entry.reference && (
                <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 3, padding: "10px 12px", fontSize: 13, lineHeight: 1.8, color: C.inkSoft, margin: "0 0 18px" }}>
                  <span style={{ color: C.ink, fontWeight: 700 }}>参照条文　</span>{entry.reference}
                </div>
              )}
              {entry.type === "tantou5" && <Tantou q={entry} picked={picked} setPicked={setPicked} submitted={submitted} />}
              {entry.type === "tashi" && <Tashi q={entry} blanks={blanks} setBlanks={setBlanks} submitted={submitted} />}
              {entry.type === "kijutsu" && <Kijutsu q={entry} revealed={revealed} setRevealed={setRevealed} />}
            </>
          )}

          {submitted && (
            <div className="flex items-center gap-3 mt-5 pt-4" style={{ borderTop: `1px dashed ${C.line}` }}>
              <Stamp kind={result} />
              <div style={{ fontSize: 14 }}>
                {result === "maru" && <b>正解</b>}
                {result === "sankaku" && <b>部分正解</b>}
                {result === "batsu" && <b>不正解</b>}
                {entry.kind === "ox" && <span style={{ color: C.inkSoft }}>　この記述は{entry.isTrue ? "正しい" : "誤り"}</span>}
                {entry.kind !== "ox" && entry.type !== "kijutsu" && (
                  <span style={{ color: C.inkSoft }}>　正解：{entry.type === "tashi"
                    ? ["ア", "イ", "ウ", "エ"].map((k) => `${k}=${entry.answer[k]}`).join(" ") : entry.answer}</span>
                )}
              </div>
            </div>
          )}
        </article>

        <div className="flex items-center justify-between mt-5">
          <button className="opt" onClick={() => go(-1)} disabled={idx === 0} style={navBtn(idx === 0)}>← 前へ</button>
          <div className="flex gap-2">
            {!submitted && entry.kind !== "ox" && entry.type === "kijutsu" && (
              <>
                <button className="opt" onClick={() => selfGrade("maru")} style={gradeBtn(C.shu)}>○ できた</button>
                <button className="opt" onClick={() => selfGrade("sankaku")} style={gradeBtn(C.inkSoft)}>△ 部分</button>
                <button className="opt" onClick={() => selfGrade("batsu")} style={gradeBtn(C.inkSoft)}>× できず</button>
              </>
            )}
            {!submitted && entry.kind !== "ox" && entry.type !== "kijutsu" && (
              <button className="opt" onClick={judge} disabled={!canSubmit} style={submitBtn(!canSubmit)}>解答する</button>
            )}
            {submitted && <button className="opt" onClick={resetTransient} style={gradeBtn(C.inkSoft)}>もう一度</button>}
          </div>
          <button className="opt" onClick={() => go(1)} disabled={idx === deck.length - 1} style={navBtn(idx === deck.length - 1)}>次へ →</button>
        </div>
      </div>
    </div>
  );
}

function OXItem({ entry, picked, submitted, onPick }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 8 }}>次の記述は正しいか、誤っているか。</div>
      <p style={{ fontFamily: MINCHO, fontSize: 16, lineHeight: 1.95, margin: "0 0 18px" }}>{entry.statement}</p>
      <div className="grid grid-cols-2 gap-3">
        {[["○", "正しい"], ["×", "誤り"]].map(([sym, lbl]) => {
          const isPick = picked === sym, isAnsTrue = (sym === "○") === entry.isTrue;
          let bg = "#fff", bd = "#e4dfd2", col = C.ink;
          if (submitted && isAnsTrue) { bg = C.shuSoft; bd = C.shu; col = C.shu; }
          else if (submitted && isPick && !isAnsTrue) { bd = C.shu; col = C.shu; }
          return (
            <button key={sym} className="opt" onClick={() => onPick(sym)} disabled={submitted}
              style={{ background: bg, border: `1.5px solid ${bd}`, borderRadius: 6, padding: "16px 0",
                cursor: submitted ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span style={{ fontFamily: MINCHO, fontSize: 26, color: col }}>{sym}</span>
              <span style={{ fontSize: 14, color: col }}>{lbl}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Tantou({ q, picked, setPicked, submitted }) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(q.choices).map(([n, text]) => {
        const isPicked = picked === n, isAnswer = q.answer === n;
        let ring = "#cfc9ba", fill = "transparent", mark = "";
        if (submitted && isAnswer) { ring = C.shu; fill = C.shu; mark = "○"; }
        else if (submitted && isPicked && !isAnswer) { ring = C.shu; mark = "×"; }
        else if (isPicked) { ring = C.ink; fill = C.ink; }
        return (
          <button key={n} className="opt text-left flex items-start gap-3"
            onClick={() => !submitted && setPicked(n)} disabled={submitted}
            style={{ background: isPicked && !submitted ? "#f4f1e7" : "#fff",
              border: `1px solid ${submitted && (isAnswer || isPicked) ? "#e3b9b1" : "#e4dfd2"}`,
              borderRadius: 4, padding: "11px 13px", cursor: submitted ? "default" : "pointer" }}>
            <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
              border: `2px solid ${ring}`, background: fill, color: fill === "transparent" ? ring : "#fff",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, marginTop: 1, fontFamily: MINCHO }}>{mark || n}</span>
            <span style={{ fontFamily: MINCHO, fontSize: 14.5, lineHeight: 1.8 }}>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

function Tashi({ q, blanks, setBlanks, submitted }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {["ア", "イ", "ウ", "エ"].map((k) => {
          const v = blanks[k], ok = submitted && v === q.answer[k], ng = submitted && v && v !== q.answer[k];
          return (
            <label key={k} className="flex items-center gap-2" style={{ background: "#fff",
              border: `1px solid ${ok ? C.shu : ng ? "#e3b9b1" : "#e4dfd2"}`, borderRadius: 4, padding: "8px 10px" }}>
              <span style={{ fontFamily: MINCHO, fontWeight: 700, color: C.shu, width: 18 }}>{k}</span>
              <select className="opt" value={v || ""} disabled={submitted}
                onChange={(e) => setBlanks({ ...blanks, [k]: e.target.value })}
                style={{ flex: 1, background: "transparent", border: "none", fontFamily: GOTHIC, fontSize: 13, color: C.ink, outline: "none" }}>
                <option value="">— 選択 —</option>
                {Object.entries(q.word_bank).map(([n, t]) => <option key={n} value={n}>{n}. {t}</option>)}
              </select>
              {submitted && <span style={{ color: C.shu, fontFamily: MINCHO }}>{ok ? "○" : "×"}</span>}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: C.inkSoft, marginBottom: 6 }}>語群</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 3, padding: "10px 12px" }}>
        {Object.entries(q.word_bank).map(([n, t]) => (
          <div key={n} style={{ fontSize: 12.5, lineHeight: 1.7, color: C.inkSoft }}>
            <span style={{ color: C.ink, fontWeight: 700 }}>{n}.</span> {t}
          </div>
        ))}
      </div>
    </div>
  );
}

function Kijutsu({ q, revealed, setRevealed }) {
  const [draft, setDraft] = useState("");
  const cells = 45;
  const chars = Array.from(draft).slice(0, cells);
  return (
    <div>
      <div style={{ fontSize: 11, color: C.inkSoft, marginBottom: 6 }}>解答欄（{draft.length}字）</div>
      <div className="grid mb-2" style={{ gridTemplateColumns: "repeat(15, 1fr)", gap: 0, border: `1px solid ${C.ink}`, borderRadius: 2, overflow: "hidden" }}>
        {Array.from({ length: cells }).map((_, i) => (
          <div key={i} style={{ aspectRatio: "1 / 1",
            borderRight: i % 15 !== 14 ? `1px solid ${C.line}` : "none",
            borderBottom: i < cells - 15 ? `1px solid ${C.line}` : "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MINCHO, fontSize: 14, color: C.ink, background: "#fff" }}>{chars[i] || ""}</div>
        ))}
      </div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder="ここに入力するとマス目に反映されます（40字程度）" rows={2} className="opt w-full"
        style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 3, padding: "8px 10px",
          fontFamily: MINCHO, fontSize: 13, lineHeight: 1.8, color: C.ink, resize: "vertical", marginBottom: 12 }} />
      {!revealed ? (
        <button className="opt" onClick={() => setRevealed(true)} style={{ background: "transparent",
          color: C.shu, border: `1px solid ${C.shu}`, borderRadius: 4, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>正解例を表示</button>
      ) : (
        <div style={{ background: C.shuSoft, border: "1px solid #e3b9b1", borderRadius: 4, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, color: C.shu, marginBottom: 4 }}>正解例（{q.answer.length}字）</div>
          <div style={{ fontFamily: MINCHO, fontSize: 15, lineHeight: 1.9 }}>{q.answer.model}</div>
        </div>
      )}
    </div>
  );
}

function labelOf(t) { return t === "tantou5" ? "5肢択一" : t === "tashi" ? "多肢選択" : "記述式"; }
function navBtn(d) { return { background: "transparent", color: d ? "#b9bcc6" : C.ink, border: "none", fontSize: 14, cursor: d ? "default" : "pointer", padding: "8px 4px", fontFamily: GOTHIC }; }
function submitBtn(d) { return { background: d ? "#c2c6d0" : C.ink, color: "#fff", border: "none", borderRadius: 4, padding: "10px 22px", fontSize: 14, fontWeight: 700, cursor: d ? "default" : "pointer", fontFamily: GOTHIC }; }
function gradeBtn(color) { return { background: "#fff", color, border: `1px solid ${color}`, borderRadius: 4, padding: "8px 12px", fontSize: 13, cursor: "pointer", fontFamily: GOTHIC }; }
