"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateScores, defaultJudgePrompt, defaultStudentPrompt, defaultTeacherPrompt,
  dimensions, emptyScores, errorTags, rubricForPrompt,
} from "@/lib/evaluation";
import type { AutoEvaluation, DialogueMessage, ModelConfig } from "@/lib/types";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_MESSAGES = 20;
// 老师在奇数轮发言。第 19 条作为兜底收束，确保不会以学生消息截断答案。
const FINAL_TEACHER_TURN = 19;
const initialConfig = (prompt: string): ModelConfig => ({
  endpoint: DEFAULT_ENDPOINT, apiKey: "", model: "", prompt,
});

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeEndpoint(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return trimmed;
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function cleanJson(raw: string) {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function isStudentDone(text: string) {
  return /我懂了|明白了|会了|听懂了|原来如此|懂啦/.test(text) && !/不懂|没懂|不会|还是/.test(text);
}

async function callModel(config: ModelConfig, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, json = false) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: normalizeEndpoint(config.endpoint), apiKey: config.apiKey,
      model: config.model, messages, temperature: json ? 0.2 : 0.7,
      ...(json ? { responseFormat: "json" } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "模型调用失败");
  return data.content as string;
}

function ModelCard({ title, icon, accent, value, onChange }: {
  title: string; icon: string; accent: string; value: ModelConfig;
  onChange: (next: ModelConfig) => void;
}) {
  const set = (key: keyof ModelConfig, next: string) => onChange({ ...value, [key]: next });
  return (
    <section className="config-card" style={{ "--accent": accent } as React.CSSProperties}>
      <div className="card-title">
        <span className="model-icon">{icon}</span>
        <div><h3>{title}</h3><p>OpenAI-compatible</p></div>
        <span className="status-dot" title="等待配置" />
      </div>
      <label>API 地址<input value={value.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://.../v1" /></label>
      <div className="field-row">
        <label>模型名称<input value={value.model} onChange={(e) => set("model", e.target.value)} placeholder="gpt-4.1-mini" /></label>
        <label>API Key<input type="password" value={value.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="sk-..." autoComplete="off" /></label>
      </div>
      <label>{title === "学生模型" ? "学生人设 Prompt" : title === "AI 老师" ? "讲题 Prompt" : "评分 Prompt"}
        <textarea value={value.prompt} onChange={(e) => set("prompt", e.target.value)} rows={title === "Judge 模型" ? 4 : 6} />
      </label>
    </section>
  );
}

function ScorePanel({ scores, onScore }: {
  scores: Record<string, number | null>;
  onScore: (id: string, score: number) => void;
}) {
  const calc = calculateScores(scores);
  return (
    <div className="score-stack">
      {dimensions.map((dimension, index) => (
        <details className="dimension" key={dimension.id} open={index === 0}>
          <summary>
            <span className="dimension-mark" style={{ background: dimension.color }}>{index + 1}</span>
            <span className="dimension-name">{dimension.name}<small>{dimension.weight} 分</small></span>
            <strong>{calc.subtotals[dimension.id]}<small> / {dimension.weight}</small></strong>
            <span className="chevron">⌄</span>
          </summary>
          <div className="criteria">
            {dimension.criteria.map((criterion) => (
              <div className="criterion" key={criterion.id}>
                <div><span>{criterion.name}</span><small>{criterion.hint}</small></div>
                <div className="score-buttons" aria-label={`${criterion.name}评分`}>
                  {[0, 1, 2, 3, 4, 5].map((value) => (
                    <button key={value} className={scores[criterion.id] === value ? "selected" : ""}
                      onClick={() => onScore(criterion.id, value)} title={`${value} 分`}>{value}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("小明有 24 颗糖，平均分给 6 个小朋友，每个小朋友分到几颗糖？");
  const [answer, setAnswer] = useState("");
  const [knowledgePoints, setKnowledgePoints] = useState("");
  const [solutionAnalysis, setSolutionAnalysis] = useState("");
  const [errorAnalysis, setErrorAnalysis] = useState("");
  const [student, setStudent] = useState(() => initialConfig(defaultStudentPrompt));
  const [teacher, setTeacher] = useState(() => initialConfig(defaultTeacherPrompt));
  const [judge, setJudge] = useState(() => initialConfig(defaultJudgePrompt));
  const [messages, setMessages] = useState<DialogueMessage[]>([]);
  const [scores, setScores] = useState<Record<string, number | null>>(() => emptyScores());
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [autoEval, setAutoEval] = useState<AutoEvaluation | null>(null);
  const [running, setRunning] = useState(false);
  const [dialogueFinished, setDialogueFinished] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"manual" | "auto">("manual");
  const [sessionId, setSessionId] = useState(uid);
  const [createdAt, setCreatedAt] = useState(() => new Date().toISOString());
  const stopRef = useRef(false);
  const messagesRef = useRef(messages);
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, running]);

  const manualCalc = useMemo(() => calculateScores(scores), [scores]);
  const problemContext = useMemo(() => [
    `题目：${question.trim()}`,
    answer.trim() && `参考答案：${answer.trim()}`,
    knowledgePoints.trim() && `知识点：${knowledgePoints.trim()}`,
    solutionAnalysis.trim() && `参考解析：${solutionAnalysis.trim()}`,
    errorAnalysis.trim() && `常见错因分析：${errorAnalysis.trim()}`,
  ].filter(Boolean).join("\n\n"), [question, answer, knowledgePoints, solutionAnalysis, errorAnalysis]);

  const validate = (config?: ModelConfig) => {
    if (!question.trim()) throw new Error("请先输入题目。");
    if (config && (!config.endpoint.trim() || !config.model.trim())) throw new Error("请填写对应模型的 API 地址和模型名称。");
  };

  const historyFor = (role: "teacher" | "student", history: DialogueMessage[]) =>
    history.map((m) => ({
      role: m.role === role ? "assistant" as const : "user" as const,
      content: `${m.role === "teacher" ? "AI 老师" : "学生"}：${m.content}`,
    }));

  const generateNext = async (forceHistory?: DialogueMessage[]) => {
    const history = forceHistory ?? messagesRef.current;
    if (history.length >= MAX_MESSAGES || dialogueFinished) return null;
    const role: "teacher" | "student" = history.length % 2 === 0 ? "teacher" : "student";
    const config = role === "teacher" ? teacher : student;
    validate(config);
    const studentJustUnderstood =
      role === "teacher" &&
      history.at(-1)?.role === "student" &&
      isStudentDone(history.at(-1)?.content ?? "");
    const mustConclude = role === "teacher" &&
      (history.length + 1 >= FINAL_TEACHER_TURN || studentJustUnderstood);
    const task = role === "teacher"
      ? history.length === 0
        ? `${problemContext}\n\n这是对话第一条消息。请开始讲解，先用简短的话确认题意，再讲第一步。参考信息仅用于保证讲解准确，不要生硬照读。`
        : mustConclude
          ? `${problemContext}\n\n现在必须结束本题讲解。请结合此前对话，完整补齐尚未讲完的关键步骤，明确写出算式、推理过程和最终答案，再用一句适合小学生的话总结。不要留下悬而未决的问题。只输出老师本轮要说的话。`
          : `${problemContext}\n\n请根据学生最新反馈继续讲解。只输出老师本轮要说的话。`
      : `${problemContext}\n\n请根据老师最新讲解，以小学生身份自然回应。只输出学生本轮要说的话。参考答案和解析只作为背景，不要直接复述或代替学生解题。`;
    const content = await callModel(config, [
      { role: "system", content: config.prompt },
      ...historyFor(role, history),
      { role: "user", content: task },
    ]);
    const next: DialogueMessage = {
      id: uid(), role, content: content.trim(), modelApi: normalizeEndpoint(config.endpoint),
      model: config.model, promptSnapshot: config.prompt, turn: history.length + 1,
      timestamp: new Date().toISOString(),
    };
    const updated = [...history, next];
    messagesRef.current = updated;
    setMessages(updated);
    return next;
  };

  const startDialogue = async () => {
    setError(""); setNotice(""); stopRef.current = false; setRunning(true);
    try {
      let local = messagesRef.current;
      if (dialogueFinished) { setNotice("本题已经完整讲解完毕。如需重跑，请先重置。"); return; }
      if (local.length >= MAX_MESSAGES) { setNotice("已达到 20 条消息上限。"); return; }
      do {
        const next = await generateNext(local);
        if (!next) break;
        local = [...local, next];
        const previousStudentUnderstood =
          next.role === "teacher" &&
          local.at(-2)?.role === "student" &&
          isStudentDone(local.at(-2)?.content ?? "");
        if (next.role === "teacher" &&
          (next.turn >= FINAL_TEACHER_TURN || previousStudentUnderstood)) {
          setDialogueFinished(true);
          setNotice(previousStudentUnderstood
            ? "学生已听懂，老师已完成最终总结。"
            : "老师已在消息上限前完整收束题目。");
          break;
        }
      } while (autoRun && !stopRef.current && local.length < MAX_MESSAGES);
      if (local.length >= MAX_MESSAGES && !dialogueFinished) {
        setNotice("已达到 20 条消息上限。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally { setRunning(false); }
  };

  const stop = () => { stopRef.current = true; setNotice("将在当前模型响应完成后停止。"); };
  const reset = () => {
    stopRef.current = true; setMessages([]); messagesRef.current = []; setScores(emptyScores());
    setDialogueFinished(false);
    setTags([]); setNotes(""); setAutoEval(null); setError(""); setNotice("");
    setSessionId(uid()); setCreatedAt(new Date().toISOString());
  };

  const runJudge = async () => {
    setError(""); setNotice(""); setRunning(true); setActiveTab("auto");
    try {
      validate(judge);
      if (!messages.length) throw new Error("请先完成至少一轮师生对话。");
      const payload = {
        problem: {
          question,
          answer,
          knowledgePoints,
          solutionAnalysis,
          errorAnalysis,
        },
        dialogue: messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content })),
        rubric: rubricForPrompt,
        requiredOutput: {
          scores: "所有 criterion id 对应 0-5 整数",
          errorTags: errorTags,
          deductions: ["具体扣分原因"], suggestions: ["具体改进建议"], summary: "总体评价",
        },
      };
      const raw = await callModel(judge, [
        { role: "system", content: judge.prompt },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ], true);
      try {
        const parsed = JSON.parse(cleanJson(raw)) as Partial<AutoEvaluation>;
        const parsedScores = emptyScores();
        for (const key of Object.keys(parsedScores)) {
          const value = parsed.scores?.[key];
          parsedScores[key] = typeof value === "number" ? Math.max(0, Math.min(5, Math.round(value))) : null;
        }
        const calc = calculateScores(parsedScores);
        setAutoEval({
          scores: parsedScores, subtotals: calc.subtotals, total: calc.total, passed: calc.passed,
          errorTags: Array.isArray(parsed.errorTags) ? parsed.errorTags.map(String) : [],
          deductions: Array.isArray(parsed.deductions) ? parsed.deductions.map(String) : [],
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          rawOutput: raw, timestamp: new Date().toISOString(),
        });
      } catch (parseError) {
        setAutoEval({
          scores: emptyScores(), subtotals: {}, total: 0, passed: false, errorTags: [],
          deductions: [], suggestions: [], rawOutput: raw,
          parseError: parseError instanceof Error ? parseError.message : "JSON 解析失败",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "自动评分失败"); }
    finally { setRunning(false); }
  };

  const applyAuto = () => {
    if (!autoEval || autoEval.parseError) return;
    setScores({ ...autoEval.scores }); setTags([...autoEval.errorTags]); setActiveTab("manual");
    setNotice("已将自动评分填入人工评分区，你仍可逐项调整。");
  };

  const exportState = () => ({
    session: { id: sessionId, createdAt, exportedAt: new Date().toISOString(), version: "1.0" },
    problem: { question, answer, knowledgePoints, solutionAnalysis, errorAnalysis },
    configurations: {
      student: { ...student, apiKey: student.apiKey ? "[REDACTED]" : "" },
      teacher: { ...teacher, apiKey: teacher.apiKey ? "[REDACTED]" : "" },
      judge: { ...judge, apiKey: judge.apiKey ? "[REDACTED]" : "" },
    },
    dialogue: {
      maxMessages: MAX_MESSAGES,
      completed: dialogueFinished,
      messages,
    },
    manualEvaluation: { scores, ...manualCalc, errorTags: tags, notes },
    autoEvaluation: autoEval,
  });

  const download = (content: string, type: string, extension: string) => {
    const blob = new Blob(["\ufeff", content], { type });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `math-evaluation-${sessionId.slice(0, 8)}.${extension}`;
    a.click(); URL.revokeObjectURL(url);
  };
  const exportJson = () => download(JSON.stringify(exportState(), null, 2), "application/json;charset=utf-8", "json");
  const exportCsv = () => {
    const state = exportState();
    const rows: string[][] = [["section", "key", "value"]];
    rows.push(
      ["session", "id", state.session.id],
      ["problem", "question", question],
      ["problem", "answer", answer],
      ["problem", "knowledgePoints", knowledgePoints],
      ["problem", "solutionAnalysis", solutionAnalysis],
      ["problem", "errorAnalysis", errorAnalysis],
    );
    messages.forEach((m) => rows.push(["dialogue", `${m.turn}-${m.role}`, m.content]));
    Object.entries(scores).forEach(([k, v]) => rows.push(["manual_score", k, v === null ? "" : String(v)]));
    rows.push(["manual", "total", String(manualCalc.total)], ["manual", "tags", tags.join("|")], ["manual", "notes", notes]);
    if (autoEval) rows.push(["auto", "total", String(autoEval.total)], ["auto", "raw", autoEval.rawOutput]);
    const escaped = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    download(escaped, "text/csv;charset=utf-8", "csv");
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">评</span><div><b>讲题评测平台</b><small>双模型小学数学讲题评测</small></div></div>
        <div className="session-chip"><span /> SESSION <b>{sessionId.slice(0, 8).toUpperCase()}</b></div>
        <div className="header-actions">
          <button className="ghost" onClick={reset}>↻ 重置</button>
          <button className="export" onClick={exportJson}>⇩ 导出 JSON</button>
          <button className="icon-btn" onClick={exportCsv} title="导出 CSV">CSV</button>
        </div>
      </header>

      {(error || notice) && <div className={`toast ${error ? "error" : ""}`}><span>{error ? "!" : "✓"}</span>{error || notice}<button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}

      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-heading"><div><small>01 / CONFIGURE</small><h2>题目与模型</h2></div><span className="step-pill">配置</span></div>
          <label className="question-box">题目文本
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} placeholder="在这里输入一道小学数学题…" />
            <span>{question.length} 字</span>
          </label>
          <div className="problem-extras">
            <label>参考答案
              <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="可选，例如：4 颗" />
            </label>
            <label>知识点
              <input value={knowledgePoints} onChange={(e) => setKnowledgePoints(e.target.value)} placeholder="可选，例如：平均分、表内除法" />
            </label>
            <label>参考解析
              <textarea value={solutionAnalysis} onChange={(e) => setSolutionAnalysis(e.target.value)} rows={3} placeholder="可选，填写标准解题过程" />
            </label>
            <label>错因分析
              <textarea value={errorAnalysis} onChange={(e) => setErrorAnalysis(e.target.value)} rows={3} placeholder="可选，填写常见错误及其原因" />
            </label>
          </div>
          <ModelCard title="学生模型" icon="生" accent="#7c8ce0" value={student} onChange={setStudent} />
          <ModelCard title="AI 老师" icon="师" accent="#e3a16c" value={teacher} onChange={setTeacher} />
          <ModelCard title="Judge 模型" icon="评" accent="#55a68e" value={judge} onChange={setJudge} />
          <p className="security-note">⌁ API Key 仅随请求传给服务器，不会写入导出文件或持久化存储。</p>
        </aside>

        <section className="chat-panel">
          <div className="panel-heading chat-heading">
            <div><small>02 / DIALOGUE</small><h2>师生对话</h2></div>
            <div className="message-count"><b>{messages.length}</b> / 20 条</div>
          </div>
          <div className="progress-track"><span style={{ width: `${messages.length * 5}%` }} /></div>
          <div className="chat-body">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <div className="orbit"><span className="teacher-orb">师</span><i>⇄</i><span className="student-orb">生</span></div>
                <h3>准备好开始一场讲题对话</h3>
                <p>老师先讲，学生会追问、打断或反馈。<br />最多 20 条，并由老师完整收束答案。</p>
                <div className="flow-preview"><span>老师讲解</span><i>→</i><span>学生反馈</span><i>→</i><span>继续引导</span></div>
              </div>
            ) : messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="avatar">{message.role === "teacher" ? "师" : "生"}</div>
                <div className="bubble-wrap">
                  <div className="message-meta"><b>{message.role === "teacher" ? "AI 老师" : "学生"}</b><span>第 {message.turn} 条 · {new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div>
                  <div className="bubble">{message.content}</div>
                  <small className="model-used">{message.model}</small>
                </div>
              </article>
            ))}
            {running && <div className={`typing ${messages.length % 2 === 0 ? "teacher" : "student"}`}><span /><span /><span /> 模型正在思考</div>}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-controls">
            <label className="switch-label"><button className={`switch ${autoRun ? "on" : ""}`} onClick={() => setAutoRun(!autoRun)}><span /></button><span>自动跑完</span></label>
            <div>
              {running ? <button className="stop-btn" onClick={stop}>■ 停止</button> : (
                <>
                  <button className="secondary-btn" onClick={startDialogue} disabled={messages.length >= MAX_MESSAGES || dialogueFinished}>＋ 继续一条</button>
                  <button className="primary-btn" onClick={startDialogue} disabled={messages.length >= MAX_MESSAGES || dialogueFinished}>{messages.length ? "继续对话" : "开始对话"} <span>→</span></button>
                </>
              )}
            </div>
          </div>
        </section>

        <aside className="right-panel">
          <div className="panel-heading score-heading">
            <div><small>03 / EVALUATE</small><h2>评分</h2></div>
            <div className={`total-ring ${manualCalc.completed ? (manualCalc.passed ? "pass" : "fail") : ""}`}>
              <b>{manualCalc.total}</b><small>/ 100</small>
            </div>
          </div>
          <div className="tabs">
            <button className={activeTab === "manual" ? "active" : ""} onClick={() => setActiveTab("manual")}>人工评分</button>
            <button className={activeTab === "auto" ? "active" : ""} onClick={() => setActiveTab("auto")}>自动评分 {autoEval && <i />}</button>
          </div>

          <div className="score-scroll">
            {activeTab === "manual" ? (
              <>
                <div className="score-guide"><span>0 异常</span><span>1–2 严重</span><span>3 普通</span><span>4 较好</span><span>5 优秀</span></div>
                <ScorePanel scores={scores} onScore={(id, score) => setScores((prev) => ({ ...prev, [id]: score }))} />
                <section className="feedback-section">
                  <h3>错误标签 <small>可多选</small></h3>
                  <div className="tags">{errorTags.map((tag) => <button key={tag} className={tags.includes(tag) ? "selected" : ""} onClick={() => setTags((prev) => prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag])}>{tag}</button>)}</div>
                  <label>人工备注<textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="记录具体问题、亮点或复盘想法…" /></label>
                </section>
              </>
            ) : (
              <div className="auto-panel">
                {!autoEval ? (
                  <div className="auto-empty"><span>✦</span><h3>让 Judge 提供参考评分</h3><p>基于题目、完整对话与同一套评分标准生成结构化建议，不会覆盖人工评分。</p></div>
                ) : autoEval.parseError ? (
                  <div className="parse-error"><h3>JSON 解析失败</h3><p>{autoEval.parseError}</p><label>模型原始输出<textarea readOnly rows={12} value={autoEval.rawOutput} /></label></div>
                ) : (
                  <>
                    <div className="auto-summary"><span>参考总分</span><b>{autoEval.total}<small> / 100</small></b><em className={autoEval.passed ? "pass" : "fail"}>{autoEval.passed ? "达到基线" : "未达 80 分基线"}</em></div>
                    {autoEval.summary && <p className="judge-summary">{autoEval.summary}</p>}
                    <ScorePanel scores={autoEval.scores} onScore={() => {}} />
                    <section className="judge-list"><h3>扣分原因</h3>{autoEval.deductions.map((x, i) => <p key={i}>− {x}</p>)}</section>
                    <section className="judge-list suggestion"><h3>改进建议</h3>{autoEval.suggestions.map((x, i) => <p key={i}>→ {x}</p>)}</section>
                    <button className="apply-btn" onClick={applyAuto}>将参考分填入人工评分</button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="judge-action">
            <button onClick={runJudge} disabled={running || !messages.length}><span>✦</span>{running && activeTab === "auto" ? "正在评分…" : "自动打分"}</button>
            <p>综合得分基线：<b>80 分</b> · 结果仅供参考</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
