import React, { useState, useMemo, useEffect, useRef } from "react";
import { loadQuestions, importQuestions, clearImportedQuestions } from "./data/loadQuestions.js";
import { loadLocalHistory, recordAnswer, syncFromServer } from "./lib/history.js";
import { isSupabaseConfigured, getCurrentUser, signIn, signOut, onAuthChange } from "./lib/supabase.js";
import { loadRemotePrefs, saveRemotePrefs } from "./lib/prefs.js";

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
    expl: q.choice_explanations ? q.choice_explanations[n] : undefined, // 肢別解説
  }));
}
/* 年度・分野・解答履歴で出題対象を絞り込む（弱点分野学習・未挑戦のみ 等） */
function filterQuestions(questions, { fields, years, studyFilter, history }) {
  let qs = questions;
  if (years && years.length) {
    const set = new Set(years);
    qs = qs.filter((q) => set.has(q.year));
  }
  if (fields && fields.length) {
    const set = new Set(fields);
    qs = qs.filter((q) => set.has(q.field));
  }
  if (studyFilter && studyFilter !== "all") {
    qs = qs.filter((q) => {
      const h = history[q.id];
      const acc = h && h.attempts ? h.correct_count / h.attempts : null;
      if (studyFilter === "unseen") return !h || !h.attempts;          // 未挑戦
      if (studyFilter === "wrong") return !!h && h.last_result === false; // 直近で間違えた
      if (studyFilter === "low") return acc !== null && acc < 0.5;       // 正答率が低い
      return true;
    });
  }
  return qs;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(questions, mode, opts = {}) {
  let qs = filterQuestions(questions, {
    fields: opts.fields, years: opts.years,
    studyFilter: opts.studyFilter, history: opts.history || {},
  });
  if (opts.order === "random") qs = shuffle(qs); // B-1: ランダム出題（問題単位でシャッフル）
  if (mode !== "ox") return qs.map((q) => ({ kind: q.type, ...q }));
  const deck = [];
  for (const q of qs) {
    if (q.type === "tantou5" && !q.all_correct) { // 全員正解(没問)は○×化しない
      const ox = toOX(q);
      if (ox) { deck.push(...ox); continue; }
    }
    deck.push({ kind: q.type, ...q });
  }
  return deck;
}

// 分野の表示順（network 化したときの一覧用）
const FIELD_ORDER = [
  "基礎法学", "憲法", "行政法", "民法", "商法・会社法",
  "政治・経済・社会", "情報通信・個人情報保護", "行政書士法等", "文章理解", "その他",
];

/* ═══════════ 正誤の星（過去正解＝白星☆ / 過去誤答＝黒星★） ═══════════ */
function Stars({ rec }) {
  const correct = rec.correct_count;
  const wrong = Math.max(0, rec.attempts - rec.correct_count);
  const CAP = 10; // 多すぎる場合は上限＋「+N」で表示
  const white = "☆".repeat(Math.min(correct, CAP));
  const black = "★".repeat(Math.min(wrong, CAP));
  return (
    <span aria-label={`過去 正解${correct} 誤答${wrong}`} title={`正解 ${correct} / 誤答 ${wrong}`}
      style={{ letterSpacing: 1, lineHeight: 1 }}>
      {correct > 0 && (
        <span style={{ color: C.shu }}>{white}{correct > CAP ? `+${correct - CAP}` : ""}</span>
      )}
      {wrong > 0 && (
        <span style={{ color: C.ink, marginLeft: correct > 0 ? 3 : 0 }}>{black}{wrong > CAP ? `+${wrong - CAP}` : ""}</span>
      )}
    </span>
  );
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

// 出題フィルタ（モード/分野/年度/学習対象）を端末に保存・復元する
const PREFS_KEY = "filterPrefs";
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

export default function GyoseiQuiz() {
  const [questions, setQuestions] = useState(null);
  const [source, setSource] = useState(null);
  const [synced, setSynced] = useState(false);
  const [user, setUser] = useState(null); // Supabase Auth のサインイン中ユーザー

  const [mode, setMode] = useState(() => loadPrefs().mode || "tantou5");
  const [idx, setIdx] = useState(0);
  const [history, setHistory] = useState({});
  const [picked, setPicked] = useState(null);
  const [blanks, setBlanks] = useState({});
  const [marks, setMarks] = useState({});   // 候補マーク {肢番号: 'keep'|'eliminate'}
  const [revealed, setRevealed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState(null);
  function setMark(n, v) { setMarks((m) => { const x = { ...m }; if (v) x[n] = v; else delete x[n]; return x; }); }

  // 文字サイズ倍率（本文の読みやすさ。端末に保存）
  const [fontScale, setFontScale] = useState(() => {
    const v = parseFloat(typeof localStorage !== "undefined" && localStorage.getItem("fontScale"));
    return v >= 0.8 && v <= 1.8 ? v : 1.15;
  });
  function changeFontScale(v) {
    setFontScale(v);
    try { localStorage.setItem("fontScale", String(v)); } catch {}
  }

  // 行間倍率（B-1。端末に保存）
  const [lineScale, setLineScale] = useState(() => {
    const v = parseFloat(typeof localStorage !== "undefined" && localStorage.getItem("lineScale"));
    return v >= 0.8 && v <= 1.4 ? v : 1.0;
  });
  function changeLineScale(v) {
    setLineScale(v);
    try { localStorage.setItem("lineScale", String(v)); } catch {}
  }

  // 画面（出題 / 集計）と出題フィルタ。フィルタは端末に保存され、次回も復元される。
  const [view, setView] = useState("quiz");
  const [selectedFields, setSelectedFields] = useState(() => loadPrefs().fields || []); // [] = 全分野
  const [selectedYears, setSelectedYears] = useState(() => loadPrefs().years || []);     // [] = 全年度
  const [studyFilter, setStudyFilter] = useState(() => loadPrefs().studyFilter || "all"); // all/unseen/wrong/low
  const [order, setOrder] = useState(() => loadPrefs().order || "seq"); // seq=順番どおり / random=ランダム
  const [deckNonce, setDeckNonce] = useState(0);            // 明示的な出題し直し

  // フィルタの変更を端末に保存（次回起動時に復元）。サインイン中はサーバーにも反映してデバイス間で揃える。
  const remoteReadyRef = useRef(false); // サーバーから一度読み込むまでは push しない（他端末の設定を上書きしないため）
  useEffect(() => {
    const p = { mode, fields: selectedFields, years: selectedYears, studyFilter, order };
    savePrefs(p);
    if (remoteReadyRef.current) saveRemotePrefs(p).catch(() => {});
  }, [mode, selectedFields, selectedYears, studyFilter, order]);

  // サインインしたらサーバーの設定でフィルタを揃える（別デバイスの続きを反映）
  useEffect(() => {
    if (!user) { remoteReadyRef.current = false; return; }
    let alive = true;
    loadRemotePrefs().then((p) => {
      if (!alive) return;
      if (p) {
        if (p.mode) setMode(p.mode);
        setSelectedFields(p.fields || []);
        setSelectedYears(p.years || []);
        setStudyFilter(p.studyFilter || "all");
        if (p.order) setOrder(p.order);
        resetTransient(); // idx は A-2 の復元に任せる（ここで先頭に戻さない）
      } else {
        // サーバー未保存なら、この端末の現在のフィルタを初期保存
        saveRemotePrefs({ mode, fields: selectedFields, years: selectedYears, studyFilter, order }).catch(() => {});
      }
      remoteReadyRef.current = true; // 以後の変更はサーバーへも反映
    });
    return () => { alive = false; };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // デッキ構築は履歴のスナップショットで行う（解答のたびに並びが変わらないように）
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);

  // 問題データの読み込み（端末ローカル優先）
  async function reloadQuestions() {
    const { questions, source } = await loadQuestions();
    setQuestions(questions);
    setSource(source);
    setIdx(0);
    resetTransient();
  }
  useEffect(() => {
    loadQuestions().then(({ questions, source }) => {
      setQuestions(questions);
      setSource(source);
    });
  }, []);

  // 履歴: まずローカル(IndexedDB)を即時反映。サインイン済みならサーバー値で上書き。
  useEffect(() => {
    let alive = true;
    loadLocalHistory().then((h) => { if (alive) setHistory(h); });

    // 認証状態を取得し、変化（サインイン/アウト）に追随
    getCurrentUser().then((u) => { if (alive) setUser(u); });
    const unsub = onAuthChange((u) => {
      if (!alive) return;
      setUser(u);
      if (!u) setSynced(false);
    });
    return () => { alive = false; unsub(); };
  }, []);

  // サインインしたら（または起動時に既存セッションがあれば）サーバー値で揃える
  useEffect(() => {
    if (!user) return;
    let alive = true;
    syncFromServer().then((h) => {
      if (alive && h) { setHistory(h); setSynced(true); }
    });
    return () => { alive = false; };
  }, [user]);

  // データに存在する分野（表示順）
  const allFields = useMemo(() => {
    if (!questions) return [];
    const present = new Set(questions.map((q) => q.field).filter(Boolean));
    return FIELD_ORDER.filter((f) => present.has(f));
  }, [questions]);

  // データに存在する年度（R2…R7 の昇順）
  const allYears = useMemo(() => {
    if (!questions) return [];
    return [...new Set(questions.map((q) => q.year).filter(Boolean))]
      .sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));
  }, [questions]);

  const fieldsKey = selectedFields.slice().sort().join(",");
  const yearsKey = selectedYears.slice().sort().join(",");
  // 解答では並びを固定したいので history はスナップショット(ref)で参照し、
  // フィルタ変更/出題し直し(deckNonce)時にだけ作り直す。
  const deck = useMemo(
    () => (questions ? buildDeck(questions, mode, { fields: selectedFields, years: selectedYears, studyFilter, order, history: historyRef.current }) : []),
    [questions, mode, fieldsKey, yearsKey, studyFilter, order, deckNonce] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const entry = deck[idx];
  const rec = entry ? history[entry.id] : null;

  // A-2: 直前に見ていた問題を再開。保存IDを「復元待ち」として持ち、デッキが（起動時の
  // フィルタ復元やサーバー設定反映で）作り直されるたびに、保存IDがデッキにあればその位置へ。
  // ユーザーが自分で移動/フィルタ変更したら復元待ちを解除する（pendingRestoreRef=null）。
  const pendingRestoreRef = useRef(typeof localStorage !== "undefined" ? localStorage.getItem("lastQuestionId") : null);
  useEffect(() => {
    if (!deck.length) return;
    const target = pendingRestoreRef.current;
    if (target) {
      const i = deck.findIndex((e) => e.id === target);
      if (i >= 0) { setIdx((cur) => (cur === i ? cur : i)); return; }
    }
    // 復元対象が無い/見つからない場合、idx がデッキ範囲外なら先頭へクランプ
    setIdx((cur) => (cur > deck.length - 1 ? 0 : cur));
  }, [deck]);
  // 現在の問題IDを端末に保存（次回起動で復元）。UI状態なので localStorage で可。
  useEffect(() => {
    if (entry?.id) { try { localStorage.setItem("lastQuestionId", entry.id); } catch {} }
  }, [entry?.id]);

  const totals = useMemo(() => {
    const vals = Object.values(history);
    return {
      seen: vals.length,
      attempts: vals.reduce((a, v) => a + v.attempts, 0),
      correct: vals.reduce((a, v) => a + v.correct_count, 0),
    };
  }, [history]);

  // 分野ごとの習得状況（網羅率・正答率）。履歴は問題ID(5択/多肢/記述)で集計。
  const fieldStats = useMemo(() => {
    if (!questions) return [];
    const map = {};
    for (const q of questions) {
      const f = q.field || "その他";
      const s = (map[f] = map[f] || { field: f, total: 0, attempted: 0, attemptSum: 0, correctSum: 0 });
      s.total++;
      const h = history[q.id];
      if (h && h.attempts) { s.attempted++; s.attemptSum += h.attempts; s.correctSum += h.correct_count; }
    }
    return allFields.map((f) => map[f]).filter(Boolean).map((s) => ({
      ...s,
      coverage: s.total ? s.attempted / s.total : 0,
      accuracy: s.attemptSum ? s.correctSum / s.attemptSum : null,
    }));
  }, [questions, history, allFields]);

  // 解答履歴ステータス別の集計（未挑戦 / 要復習 / 習得）
  const statusCounts = useMemo(() => {
    let unseen = 0, review = 0, mastered = 0;
    for (const q of questions || []) {
      const h = history[q.id];
      if (!h || !h.attempts) unseen++;
      else if (h.last_result === false || h.correct_count / h.attempts < 0.5) review++;
      else mastered++;
    }
    const total = (questions || []).length;
    return { unseen, review, mastered, total };
  }, [questions, history]);

  // B-2: ○×一問一答に変換できない5択の取りこぼし一覧（極性判定不能 / 組合せ問題）
  const oxIssues = useMemo(() => {
    const combo = [], polarity = [];
    for (const q of questions || []) {
      if (q.type !== "tantou5" || !q.choices || Object.keys(q.choices).length === 0) continue;
      if (!detectPolarity(q.stem)) polarity.push(`${q.year}-${q.number}`);
      else if (isCombo(q.choices)) combo.push(`${q.year}-${q.number}`);
    }
    return { combo, polarity };
  }, [questions]);

  function rebuildDeck() { pendingRestoreRef.current = null; setIdx(0); resetTransient(); setDeckNonce((n) => n + 1); }
  function applyFields(next) { setSelectedFields(next); rebuildDeck(); }
  function applyYears(next) { setSelectedYears(next); rebuildDeck(); }
  function applyStudyFilter(s) { setStudyFilter(s); rebuildDeck(); }
  function applyOrder(o) { setOrder(o); rebuildDeck(); }                       // B-1
  function clearAllFilters() { setSelectedFields([]); setSelectedYears([]); setStudyFilter("all"); rebuildDeck(); } // B-3

  // B-3: 現データに存在しない年度/分野が保存フィルタに残って0件になるのを防ぐ（読込時に正規化）
  useEffect(() => {
    if (!questions) return;
    setSelectedYears((prev) => { const n = prev.filter((y) => allYears.includes(y)); return n.length === prev.length ? prev : n; });
    setSelectedFields((prev) => { const n = prev.filter((f) => allFields.includes(f)); return n.length === prev.length ? prev : n; });
  }, [allYears, allFields]); // eslint-disable-line react-hooks/exhaustive-deps
  // 集計画面から「この分野を弱点学習」: 分野を絞り+間違い/未挑戦中心に出題
  function studyField(field) {
    pendingRestoreRef.current = null;
    setSelectedFields([field]); setStudyFilter("wrong"); setView("quiz");
    setMode("tantou5"); setIdx(0); resetTransient(); setDeckNonce((n) => n + 1);
  }

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
    setPicked(null); setBlanks({}); setMarks({}); setRevealed(false);
    setSubmitted(false); setResult(null);
  }
  function go(delta) {
    pendingRestoreRef.current = null; // ユーザーが移動したら復元待ちを解除
    const n = Math.min(Math.max(idx + delta, 0), deck.length - 1);
    setIdx(n); resetTransient();
  }
  function switchMode(m) { pendingRestoreRef.current = null; setMode(m); setIdx(0); resetTransient(); }

  function judge() {
    let correct = null, chosen = null, res = null;
    if (entry.type === "tantou5") {
      chosen = picked; correct = entry.all_correct ? true : picked === entry.answer; // 全員正解はどの肢でも正解
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

  const canSubmit = entry && (
    (entry.type === "tantou5" && picked) ||
    (entry.type === "tashi" && ["ア", "イ", "ウ", "エ"].every((k) => blanks[k])));

  const syncLabel = !isSupabaseConfigured
    ? "ローカル保存"
    : !user
      ? "未サインイン（ローカル保存）"
      : synced ? "同期済み" : "サインイン済み（同期中…）";

  return (
    <div style={{ background: C.bg, minHeight: "100%", fontFamily: GOTHIC, color: C.ink, "--rs": fontScale, "--ls": lineScale }}>
      <style>{`
        @keyframes stampIn{0%{opacity:0;transform:scale(1.6) rotate(-12deg)}
          60%{opacity:1;transform:scale(.92) rotate(-12deg)}100%{transform:scale(1) rotate(-12deg)}}
        .stamp{animation:stampIn .28s ease-out;transform:rotate(-12deg)}
        @media (prefers-reduced-motion:reduce){.stamp{animation:none}}
        .opt:focus-visible{outline:2px solid ${C.ink};outline-offset:2px}
      `}</style>

      <div className="mx-auto" style={{ maxWidth: 760, padding: "20px 16px 56px" }}>
        <div className="flex items-center justify-between mb-4" style={{ gap: 8 }}>
          {/* 出題 / 集計 タブ */}
          <div className="flex gap-1" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: 3, width: "fit-content" }}>
            {[["quiz", "出題"], ["dash", "集計"]].map(([v, lbl]) => (
              <button key={v} className="opt" onClick={() => setView(v)} style={{
                background: view === v ? C.ink : "transparent", color: view === v ? "#fff" : C.inkSoft,
                border: "none", borderRadius: 4, padding: "6px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{lbl}</button>
            ))}
          </div>
          <div className="flex items-center" style={{ gap: 8, fontSize: 11, color: C.inkSoft }}>
            <FontSizeControl scale={fontScale} onChange={changeFontScale} />
            <LineSpacingControl scale={lineScale} onChange={changeLineScale} />
            {source === "sample" && (
              <span style={{ color: C.shu, border: `1px solid ${C.shu}`, borderRadius: 2, padding: "2px 6px" }}>サンプル問題</span>
            )}
            <span>{syncLabel}</span>
          </div>
        </div>

        {isSupabaseConfigured && <AuthBar user={user} onSignOut={() => setUser(null)} />}

        <QuestionsBar source={source} count={questions.length} onChange={reloadQuestions} />

        {view === "dash" ? (
          <Dashboard fieldStats={fieldStats} statusCounts={statusCounts} oxIssues={oxIssues}
            selectedFields={selectedFields} onStudyField={studyField} onPickField={applyFields} />
        ) : (
        <>
        {/* 出題条件 */}
        <FilterBar
          mode={mode} onMode={switchMode}
          allFields={allFields} selectedFields={selectedFields} onFields={applyFields}
          allYears={allYears} selectedYears={selectedYears} onYears={applyYears}
          studyFilter={studyFilter} onStudyFilter={applyStudyFilter}
          order={order} onOrder={applyOrder}
          deckLen={deck.length} onRebuild={rebuildDeck}
        />

        {!entry ? (
          <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 4, padding: "40px 22px", textAlign: "center", color: C.inkSoft }}>
            <div style={{ fontFamily: MINCHO, fontSize: 16, marginBottom: 8 }}>該当する問題がありません</div>
            <div style={{ fontSize: 12, marginBottom: 14 }}>分野や「学習対象」の条件をゆるめてください（例: 学習対象を「すべて」に）。</div>
            <button className="opt" onClick={clearAllFilters}
              style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>
              フィルタを全解除
            </button>
          </div>
        ) : (
        <>

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
            {rec && rec.attempts > 0 && (
              <span className="flex items-center" style={{ fontSize: 11, color: C.inkSoft, gap: 6 }}>
                <Stars rec={rec} />
                <span>{rec.attempts}回中 <b style={{ color: C.ink }}>{rec.correct_count}</b> 正解</span>
              </span>
            )}
          </div>

          {entry.kind === "ox" ? (
            <OXItem entry={entry} picked={picked} submitted={submitted} onPick={judgeOX} />
          ) : (
            <>
              <p style={{ fontFamily: MINCHO, fontSize: "calc(16px * var(--rs))", lineHeight: "calc(1.9 * var(--ls))", margin: "0 0 18px", whiteSpace: "pre-wrap" }}>{entry.stem}</p>
              {entry.reference && (
                <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 3, padding: "10px 12px", fontSize: "calc(13px * var(--rs))", lineHeight: "calc(1.8 * var(--ls))", color: C.inkSoft, margin: "0 0 18px" }}>
                  <span style={{ color: C.ink, fontWeight: 700 }}>参照条文　</span>{entry.reference}
                </div>
              )}
              {entry.type === "tantou5" && <Tantou q={entry} picked={picked} setPicked={setPicked} submitted={submitted} marks={marks} setMark={setMark} />}
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
                {entry.all_correct && <span style={{ color: C.inkSoft }}>　全員正解（公式に没問）</span>}
                {!entry.all_correct && entry.kind !== "ox" && entry.type !== "kijutsu" && (
                  <span style={{ color: C.inkSoft }}>　正解：{entry.type === "tashi"
                    ? ["ア", "イ", "ウ", "エ"].map((k) => `${k}=${entry.answer[k]}`).join(" ") : entry.answer}</span>
                )}
              </div>
            </div>
          )}
          {submitted && <Explanation entry={entry} />}
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
        </>
        )}
        </>
        )}
      </div>
    </div>
  );
}

/* ═══════════ 問題データの取り込み（端末ローカル / サーバーに送らない） ═══════════ */
function QuestionsBar({ source, count, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const inputRef = React.useRef(null);

  const label =
    source === "imported" ? `取り込み済み（${count}問・この端末）`
    : source === "local-file" ? `ローカルファイル（${count}問）`
    : `サンプル（${count}問）`;

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const json = JSON.parse(await file.text());
      const n = await importQuestions(json);
      setMsg(`${n}問を取り込みました（この端末にのみ保存）`);
      await onChange();
    } catch (err) {
      setMsg("読み込み失敗: " + (err?.message || "JSON形式を確認してください"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onClear() {
    setBusy(true); setMsg(null);
    await clearImportedQuestions();
    setMsg("取り込みを削除しました（サンプルに戻ります）");
    await onChange();
    setBusy(false);
  }

  return (
    <div className="mb-4" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px" }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span style={{ fontSize: 11, color: C.inkSoft }}>
          問題データ：<b style={{ color: C.ink }}>{label}</b>
        </span>
        <button className="opt" onClick={() => setOpen((v) => !v)}
          style={{ background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: GOTHIC }}>
          {open ? "閉じる" : "取り込み / 差し替え"}
        </button>
      </div>
      {open && (
        <div className="mt-2 pt-2" style={{ borderTop: `1px dashed ${C.line}`, fontSize: 11, color: C.inkSoft }}>
          <div style={{ marginBottom: 6 }}>
            自分の <code>questions.json</code> を選ぶと、<b>この端末（ブラウザ）にだけ</b>保存します。サーバーには送りません。
          </div>
          <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
            <input ref={inputRef} className="opt" type="file" accept="application/json,.json" disabled={busy}
              onChange={onFile} style={{ fontSize: 11 }} />
            {source === "imported" && (
              <button className="opt" onClick={onClear} disabled={busy}
                style={{ background: "transparent", color: C.shu, border: `1px solid ${C.shu}`, borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: GOTHIC }}>
                取り込みを削除
              </button>
            )}
          </div>
          {msg && <div style={{ marginTop: 6, color: C.ink }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

/* ═══════════ サインイン（Supabase Auth / 本人のみ） ═══════════ */
function AuthBar({ user, onSignOut }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (user) {
    return (
      <div className="flex items-center justify-end mb-4" style={{ gap: 10, fontSize: 11, color: C.inkSoft }}>
        <span>{user.email}</span>
        <button className="opt" onClick={async () => { await signOut(); onSignOut(); }}
          style={{ background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontFamily: GOTHIC }}>
          サインアウト
        </button>
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error) setErr(error.message || "サインインに失敗しました");
    // 成功時は onAuthChange 経由で user が更新される
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center mb-4"
      style={{ gap: 8, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px" }}>
      <span style={{ fontSize: 11, color: C.inkSoft }}>履歴を同期するにはサインイン：</span>
      <input className="opt" type="email" required placeholder="メールアドレス" value={email}
        autoComplete="username" onChange={(e) => setEmail(e.target.value)}
        style={{ flex: "1 1 160px", minWidth: 0, border: `1px solid ${C.line}`, borderRadius: 4, padding: "6px 8px", fontSize: 12, fontFamily: GOTHIC }} />
      <input className="opt" type="password" required placeholder="パスワード" value={password}
        autoComplete="current-password" onChange={(e) => setPassword(e.target.value)}
        style={{ flex: "1 1 140px", minWidth: 0, border: `1px solid ${C.line}`, borderRadius: 4, padding: "6px 8px", fontSize: 12, fontFamily: GOTHIC }} />
      <button className="opt" type="submit" disabled={busy}
        style={{ background: busy ? "#c2c6d0" : C.ink, color: "#fff", border: "none", borderRadius: 4, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: GOTHIC }}>
        {busy ? "…" : "サインイン"}
      </button>
      {err && <span style={{ fontSize: 11, color: C.shu, flexBasis: "100%" }}>{err}</span>}
    </form>
  );
}

/* ═══════════ 文字サイズ調整 ═══════════ */
function FontSizeControl({ scale, onChange }) {
  const steps = [["小", 1.0], ["中", 1.15], ["大", 1.35], ["特大", 1.6]];
  return (
    <div className="flex items-center" style={{ gap: 2, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: 2 }}>
      <span style={{ fontSize: 11, color: C.inkSoft, padding: "0 4px" }} aria-hidden>字</span>
      {steps.map(([lbl, v]) => {
        const active = Math.abs(scale - v) < 0.001;
        return (
          <button key={lbl} className="opt" onClick={() => onChange(v)}
            aria-label={`文字サイズ ${lbl}`} aria-pressed={active}
            style={{ background: active ? C.ink : "transparent", color: active ? "#fff" : C.inkSoft,
              border: "none", borderRadius: 4, padding: "3px 7px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{lbl}</button>
        );
      })}
    </div>
  );
}

/* ═══════════ 行間調整（B-1） ═══════════ */
function LineSpacingControl({ scale, onChange }) {
  const steps = [["詰", 0.85], ["標準", 1.0], ["広", 1.2]];
  return (
    <div className="flex items-center" style={{ gap: 2, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: 2 }}>
      <span style={{ fontSize: 11, color: C.inkSoft, padding: "0 4px" }} aria-hidden>行間</span>
      {steps.map(([lbl, v]) => {
        const active = Math.abs(scale - v) < 0.001;
        return (
          <button key={lbl} className="opt" onClick={() => onChange(v)}
            aria-label={`行間 ${lbl}`} aria-pressed={active}
            style={{ background: active ? C.ink : "transparent", color: active ? "#fff" : C.inkSoft,
              border: "none", borderRadius: 4, padding: "3px 7px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{lbl}</button>
        );
      })}
    </div>
  );
}

/* ═══════════ 出題条件バー（分野・学習対象・モード） ═══════════ */
function chip(active) {
  return { background: active ? C.ink : "#fff", color: active ? "#fff" : C.inkSoft,
    border: `1px solid ${active ? C.ink : C.line}`, borderRadius: 999, padding: "3px 10px",
    fontSize: 11, cursor: "pointer", fontFamily: GOTHIC };
}
function FilterBar({ mode, onMode, allFields, selectedFields, onFields, allYears, selectedYears, onYears, studyFilter, onStudyFilter, order, onOrder, deckLen, onRebuild }) {
  const sel = new Set(selectedFields);
  function toggle(f) {
    const next = new Set(sel);
    next.has(f) ? next.delete(f) : next.add(f);
    onFields([...next]);
  }
  const ysel = new Set(selectedYears);
  function toggleYear(y) {
    const next = new Set(ysel);
    next.has(y) ? next.delete(y) : next.add(y);
    onYears([...next]);
  }
  const studyOpts = [["all", "すべて"], ["unseen", "未挑戦"], ["wrong", "間違えた"], ["low", "正答率が低い"]];
  return (
    <div className="mb-4" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "10px 12px" }}>
      <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 8 }}>
        <div className="flex gap-1" style={{ background: C.bg, borderRadius: 6, padding: 3 }}>
          {[["tantou5", "5肢択一"], ["ox", "○×一問一答"]].map(([m, l]) => (
            <button key={m} className="opt" onClick={() => onMode(m)} style={{
              background: mode === m ? C.ink : "transparent", color: mode === m ? "#fff" : C.inkSoft,
              border: "none", borderRadius: 4, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{l}</button>
          ))}
        </div>
        <label style={{ fontSize: 11, color: C.inkSoft }}>学習対象：
          <select className="opt" value={studyFilter} onChange={(e) => onStudyFilter(e.target.value)}
            style={{ marginLeft: 4, border: `1px solid ${C.line}`, borderRadius: 4, padding: "4px 6px", fontSize: 12, fontFamily: GOTHIC, color: C.ink }}>
            {studyOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <div className="flex gap-1" style={{ background: C.bg, borderRadius: 6, padding: 3 }}>
          {[["seq", "順番"], ["random", "ランダム"]].map(([o, l]) => (
            <button key={o} className="opt" onClick={() => onOrder(o)} style={{
              background: order === o ? C.ink : "transparent", color: order === o ? "#fff" : C.inkSoft,
              border: "none", borderRadius: 4, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC }}>{l}</button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: C.inkSoft, marginLeft: "auto" }}>{deckLen}問</span>
        <button className="opt" onClick={onRebuild} style={{ background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: GOTHIC }}>出題し直す</button>
      </div>
      {allYears.length > 1 && (
        <div className="flex items-center flex-wrap" style={{ gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.inkSoft, marginRight: 2 }}>年度</span>
          <button className="opt" onClick={() => onYears([])} style={chip(selectedYears.length === 0)}>全年度</button>
          {allYears.map((y) => (
            <button key={y} className="opt" onClick={() => toggleYear(y)} style={chip(ysel.has(y))}>{y}</button>
          ))}
        </div>
      )}
      <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
        <span style={{ fontSize: 11, color: C.inkSoft, marginRight: 2 }}>分野</span>
        <button className="opt" onClick={() => onFields([])} style={chip(selectedFields.length === 0)}>全分野</button>
        {allFields.map((f) => (
          <button key={f} className="opt" onClick={() => toggle(f)} style={chip(sel.has(f))}>{f}</button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════ 集計ダッシュボード（網羅率・分野別の習得状況） ═══════════ */
function miniBtn(primary) {
  return { background: primary ? C.shu : "transparent", color: primary ? "#fff" : C.inkSoft,
    border: `1px solid ${primary ? C.shu : C.line}`, borderRadius: 4, padding: "4px 10px",
    fontSize: 11, cursor: "pointer", fontFamily: GOTHIC };
}
function Dashboard({ fieldStats, statusCounts, oxIssues, onStudyField, onPickField }) {
  const [showOx, setShowOx] = useState(false);
  const pct = (n) => Math.round(n * 100);
  const oxMiss = oxIssues ? oxIssues.combo.length + oxIssues.polarity.length : 0;
  const done = statusCounts.total - statusCounts.unseen;
  const overallCov = statusCounts.total ? done / statusCounts.total : 0;
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 mb-4">
        {[["未挑戦", statusCounts.unseen, C.inkSoft], ["要復習", statusCounts.review, C.shu], ["習得", statusCounts.mastered, C.ink]].map(([l, v, col]) => (
          <div key={l} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "12px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: C.inkSoft }}>{l}</div>
            <div style={{ fontFamily: MINCHO, fontSize: 24, fontWeight: 700, color: col }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 4 }}>網羅率 {pct(overallCov)}%（{done}/{statusCounts.total}問に挑戦）</div>
      <div style={{ height: 6, background: C.line, borderRadius: 3, marginBottom: 18 }}>
        <div style={{ height: "100%", width: `${pct(overallCov)}%`, background: C.ink, borderRadius: 3, transition: "width .3s" }} />
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>分野ごとの習得状況</div>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {fieldStats.map((s) => {
          const acc = s.accuracy == null ? null : pct(s.accuracy);
          const cov = pct(s.coverage);
          const weak = s.accuracy != null && s.accuracy < 0.6;
          return (
            <div key={s.field} style={{ background: "#fff", border: `1px solid ${weak ? C.shu : C.line}`, borderRadius: 6, padding: "10px 12px" }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                <span style={{ fontFamily: MINCHO, fontSize: 14, fontWeight: 700 }}>
                  {s.field}{weak && <span style={{ fontSize: 10, color: C.shu, marginLeft: 6 }}>弱点</span>}
                </span>
                <span style={{ fontSize: 11, color: C.inkSoft }}>
                  {s.attempted}/{s.total}問 ・ 正答率 {acc == null ? "—" : acc + "%"}
                </span>
              </div>
              <div style={{ height: 5, background: C.bg, borderRadius: 3, marginBottom: 8 }}>
                <div style={{ height: "100%", width: `${cov}%`, background: acc == null ? C.inkSoft : weak ? C.shu : C.ink, borderRadius: 3 }} />
              </div>
              <div className="flex" style={{ gap: 8 }}>
                <button className="opt" onClick={() => onPickField([s.field])} style={miniBtn(false)}>この分野を出題</button>
                <button className="opt" onClick={() => onStudyField(s.field)} style={miniBtn(true)}>弱点だけ復習</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* B-2: ○×一問一答に変換できない5択の取りこぼし一覧 */}
      {oxMiss > 0 && (
        <div className="mt-5" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "10px 12px" }}>
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 12, color: C.inkSoft }}>
              ○×一問一答に変換できない5択：<b style={{ color: C.ink }}>{oxMiss}</b>問
              <span style={{ marginLeft: 6 }}>（組合せ {oxIssues.combo.length} / 極性不明 {oxIssues.polarity.length}）</span>
            </span>
            <button className="opt" onClick={() => setShowOx((v) => !v)} style={miniBtn(false)}>{showOx ? "閉じる" : "一覧"}</button>
          </div>
          {showOx && (
            <div className="mt-2 pt-2" style={{ borderTop: `1px dashed ${C.line}`, fontSize: 11, color: C.inkSoft, lineHeight: "calc(1.9 * var(--ls))" }}>
              {oxIssues.combo.length > 0 && <div><b style={{ color: C.ink }}>組合せ問題</b>（5択のまま出題）：{oxIssues.combo.join("、")}</div>}
              {oxIssues.polarity.length > 0 && <div className="mt-1"><b style={{ color: C.ink }}>極性判定不能</b>（正誤どちらを選ぶか不明）：{oxIssues.polarity.join("、")}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════ 解説（総合 + 肢別。AI生成・端末ローカル） ═══════════ */
function Explanation({ entry }) {
  // ○×一問一答: その肢の肢別解説のみ
  if (entry.kind === "ox") {
    if (!entry.expl) return null;
    return (
      <div className="mt-4 pt-4" style={{ borderTop: `1px dashed ${C.line}` }}>
        <ExplBlock label="解説" text={entry.expl} />
      </div>
    );
  }

  const hasSummary = !!entry.explanation;
  const se = entry.type === "tantou5" ? entry.statement_explanations : null; // 組合せ問題の記述別
  const ce = entry.type === "tantou5" ? entry.choice_explanations : null;     // 通常5択の肢別
  const hasSE = se && Object.keys(se).length > 0;
  const hasCE = !hasSE && ce && Object.keys(ce).length > 0;
  if (!hasSummary && !hasSE && !hasCE) return null;

  const comboNote = hasSE && entry.answer
    ? `正解の組合せ：${entry.answer}（${(entry.choices || {})[entry.answer] || ""}）` : null;

  return (
    <div className="mt-4 pt-4" style={{ borderTop: `1px dashed ${C.line}` }}>
      {hasSummary && <ExplBlock label="解説" text={entry.explanation} />}
      {hasSE && <ExplList title="各記述の解説" items={Object.entries(se)} note={comboNote} />}
      {hasCE && <ExplList title="各肢の解説" items={Object.entries(ce)} />}
    </div>
  );
}
// 解説テキストの冒頭の判定語から ○/× を導く（誤り/妥当でない を先に判定）
function verdictMark(text) {
  const t = (text || "").trimStart();
  if (/^(誤り|妥当でない|妥当ではない|適切でない|不適切|誤っている|×)/.test(t)) return "×";
  if (/^(正しい|妥当|適切|○)/.test(t)) return "○";
  return null;
}
function ExplList({ title, items, note }) {
  return (
    <div className="mt-3">
      <div style={{ fontSize: 11, color: C.inkSoft, marginBottom: 6 }}>
        {title}{note && <span style={{ marginLeft: 8, color: C.shu }}>{note}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {items.map(([n, text]) => {
          if (!text) return null;
          const m = verdictMark(text);
          const col = m === "○" ? "#2e7d4f" : m === "×" ? C.shu : C.inkSoft; // ○=緑 / ×=朱
          return (
            <div key={n} className="flex items-start gap-2"
              style={{ fontSize: "calc(13px * var(--rs))", lineHeight: "calc(1.8 * var(--ls))" }}>
              <span style={{ flexShrink: 0, fontFamily: MINCHO, fontWeight: 700, color: col }}>{n}{m || ""}</span>
              <span style={{ color: C.inkSoft }}>{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function ExplBlock({ label, text }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 4, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: C.shu, marginBottom: 4, fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: MINCHO, fontSize: "calc(14px * var(--rs))", lineHeight: "calc(1.9 * var(--ls))", color: C.ink, whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}

function OXItem({ entry, picked, submitted, onPick }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 8 }}>次の記述は正しいか、誤っているか。</div>
      <p style={{ fontFamily: MINCHO, fontSize: "calc(16px * var(--rs))", lineHeight: "calc(1.95 * var(--ls))", margin: "0 0 18px" }}>{entry.statement}</p>
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

function Tantou({ q, picked, setPicked, submitted, marks = {}, setMark }) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(q.choices).map(([n, text]) => {
        // 全員正解(没問)は選んだ肢を正解扱いで表示
        const isPicked = picked === n, isAnswer = q.all_correct ? isPicked : q.answer === n;
        const mk = marks[n]; // 'keep' | 'eliminate' | undefined（候補マーク）
        let ring = "#cfc9ba", fill = "transparent", mark = "";
        if (submitted && isAnswer) { ring = C.shu; fill = C.shu; mark = "○"; }
        else if (submitted && isPicked && !isAnswer) { ring = C.shu; mark = "×"; }
        else if (isPicked) { ring = C.ink; fill = C.ink; }
        const eliminated = mk === "eliminate" && !submitted;
        return (
          <div key={n} className="flex items-stretch gap-2">
            <button className="opt text-left flex items-start gap-3"
              onClick={() => !submitted && setPicked(n)} disabled={submitted}
              style={{ flex: 1, minWidth: 0, background: isPicked && !submitted ? "#f4f1e7" : "#fff",
                border: `1px solid ${mk === "keep" && !submitted ? C.ink : submitted && (isAnswer || isPicked) ? "#e3b9b1" : "#e4dfd2"}`,
                borderRadius: 4, padding: "11px 13px", cursor: submitted ? "default" : "pointer", opacity: eliminated ? 0.45 : 1 }}>
              <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
                border: `2px solid ${ring}`, background: fill, color: fill === "transparent" ? ring : "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, marginTop: 1, fontFamily: MINCHO }}>{mark || n}</span>
              <span style={{ fontFamily: MINCHO, fontSize: "calc(14.5px * var(--rs))", lineHeight: "calc(1.8 * var(--ls))",
                textDecoration: eliminated ? "line-through" : "none" }}>{text}</span>
            </button>
            {!submitted && setMark && <MarkControl value={mk} onChange={(v) => setMark(n, v)} />}
          </div>
        );
      })}
    </div>
  );
}
// 候補マーク: ○候補 / ×候補 / 解除（縦3ボタン）。最終解答とは別の作業メモ。
function MarkControl({ value, onChange }) {
  const opts = [["keep", "○"], ["eliminate", "×"], [null, "−"]];
  return (
    <div className="flex flex-col" style={{ gap: 2, flexShrink: 0 }} role="group" aria-label="候補マーク">
      {opts.map(([v, lbl]) => {
        const active = value === v || (v === null && !value);
        const col = v === "keep" ? "#2e7d4f" : v === "eliminate" ? C.shu : C.inkSoft;
        return (
          <button key={lbl} className="opt" onClick={(e) => { e.stopPropagation(); onChange(v); }}
            aria-pressed={active}
            style={{ width: 30, padding: "2px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: GOTHIC,
              borderRadius: 4, border: `1px solid ${active ? col : C.line}`,
              background: active && v ? col : "#fff", color: active && v ? "#fff" : col }}>{lbl}</button>
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
                style={{ flex: 1, background: "transparent", border: "none", fontFamily: GOTHIC, fontSize: "calc(13px * var(--rs))", color: C.ink, outline: "none" }}>
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
          <div key={n} style={{ fontSize: "calc(12.5px * var(--rs))", lineHeight: "calc(1.7 * var(--ls))", color: C.inkSoft }}>
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
            fontFamily: MINCHO, fontSize: "calc(14px * var(--rs))", color: C.ink, background: "#fff" }}>{chars[i] || ""}</div>
        ))}
      </div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder="ここに入力するとマス目に反映されます（40字程度）" rows={2} className="opt w-full"
        style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 3, padding: "8px 10px",
          fontFamily: MINCHO, fontSize: "calc(13px * var(--rs))", lineHeight: "calc(1.8 * var(--ls))", color: C.ink, resize: "vertical", marginBottom: 12 }} />
      {!revealed ? (
        <button className="opt" onClick={() => setRevealed(true)} style={{ background: "transparent",
          color: C.shu, border: `1px solid ${C.shu}`, borderRadius: 4, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>正解例を表示</button>
      ) : (
        <div style={{ background: C.shuSoft, border: "1px solid #e3b9b1", borderRadius: 4, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, color: C.shu, marginBottom: 4 }}>正解例（{q.answer.length}字）</div>
          <div style={{ fontFamily: MINCHO, fontSize: "calc(15px * var(--rs))", lineHeight: "calc(1.9 * var(--ls))" }}>{q.answer.model}</div>
        </div>
      )}
    </div>
  );
}

function labelOf(t) { return t === "tantou5" ? "5肢択一" : t === "tashi" ? "多肢選択" : "記述式"; }
function navBtn(d) { return { background: "transparent", color: d ? "#b9bcc6" : C.ink, border: "none", fontSize: 14, cursor: d ? "default" : "pointer", padding: "8px 4px", fontFamily: GOTHIC }; }
function submitBtn(d) { return { background: d ? "#c2c6d0" : C.ink, color: "#fff", border: "none", borderRadius: 4, padding: "10px 22px", fontSize: 14, fontWeight: 700, cursor: d ? "default" : "pointer", fontFamily: GOTHIC }; }
function gradeBtn(color) { return { background: "#fff", color, border: `1px solid ${color}`, borderRadius: 4, padding: "8px 12px", fontSize: 13, cursor: "pointer", fontFamily: GOTHIC }; }
