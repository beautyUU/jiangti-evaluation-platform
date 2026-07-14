"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import * as XLSX from "xlsx";
import {
  calculateScores, defaultJudgePrompt, defaultStudentPrompt, defaultTeacherPrompt,
  dimensions, emptyScores, errorTags,
} from "@/lib/evaluation";
import type { AutoEvaluation, DialogueMessage, ModelConfig } from "@/lib/types";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_MESSAGES = 20;
// 老师在奇数轮发言。第 19 条作为兜底收束，确保不会以学生消息截断答案。
const FINAL_TEACHER_TURN = 19;
type ProblemInput = {
  question: string;
  originalImage: string;
  answer: string;
  knowledgePoints: string;
  solutionAnalysis: string;
  errorAnalysis: string;
};

type EvaluationExportState = {
  session: { id: string; createdAt: string; exportedAt: string; version: string };
  problem: ProblemInput;
  configurations: {
    student: ModelConfig;
    teacher: ModelConfig;
    judge: ModelConfig;
  };
  dialogue: {
    maxMessages: number;
    completed: boolean;
    messages: DialogueMessage[];
  };
  manualEvaluation: ReturnType<typeof calculateScores> & {
    scores: Record<string, number | null>;
    errorTags: string[];
    notes: string;
  };
  autoEvaluation: AutoEvaluation | null;
};

type ExperimentSnapshot = {
  id: string;
  savedAt: string;
  title: string;
  state: EvaluationExportState;
};

const excelHeaderAliases: Record<keyof ProblemInput, string[]> = {
  question: ["题目", "题干", "题目文本", "问题"],
  originalImage: ["原图", "图片", "题图", "题目图片", "图片链接", "原图链接", "image", "imageUrl", "imageURL"],
  answer: ["答案", "参考答案", "标准答案"],
  knowledgePoints: ["知识点", "考点", "涉及知识点"],
  solutionAnalysis: ["解析", "参考解析", "答案解析", "解题过程", "解法"],
  errorAnalysis: ["错因分析", "错因", "错误原因", "常见错因"],
};
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
  const cleaned = stripThinking(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) return cleaned.slice(firstObject, lastObject + 1);
  return cleaned;
}

function stripThinking(raw: string) {
  return raw
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, "")
    .replace(/^\s*(思考过程|推理过程|分析过程)\s*[:：][\s\S]*?(?=\n{2,}|$)/i, "")
    .trim();
}

function isStudentDone(text: string) {
  return /我懂了|明白了|会了|听懂了|原来如此|懂啦/.test(text) && !/不懂|没懂|不会|还是/.test(text);
}

function isPreviewableImage(value: string) {
  return /^(https?:\/\/|data:image\/|blob:)/i.test(value.trim());
}

function imageReferenceForModel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^data:image\//i.test(trimmed)) return "已上传题目原图，页面可预览；当前模型调用仅传递文字题目与参考信息。";
  return trimmed;
}

async function callModel(
  config: ModelConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  lowTemperature = false,
  maxTokens?: number,
) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: normalizeEndpoint(config.endpoint), apiKey: config.apiKey,
      model: config.model, messages, temperature: lowTemperature ? 0.2 : 0.7,
      maxTokens,
    }),
  });
  const raw = await response.text();
  let data: { content?: string; error?: string; raw?: string; details?: string; upstreamStatus?: number; upstreamRaw?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    const looksLikeHtml = /^\s*</.test(raw);
    const summary = raw.replace(/\s+/g, " ").slice(0, 500);
    throw new Error(looksLikeHtml
      ? [
        "接口返回了网页内容，不是模型 JSON 响应。",
        `前端请求状态：HTTP ${response.status}`,
        "如果只在自动打分时出现，通常是 Judge 请求过长或模型响应过慢，被部署平台/网关返回了 HTML 错误页。",
        `网页摘要：${summary}`,
      ].join("\n")
      : `接口返回了非 JSON 内容（HTTP ${response.status}）：${summary}`);
  }
  if (!response.ok) {
    const parts = [
      data.error || "模型调用失败",
      `前端请求状态：HTTP ${response.status}`,
      data.upstreamStatus ? `模型接口状态：HTTP ${data.upstreamStatus}` : "",
      data.details ? `错误详情：${data.details}` : "",
      data.raw ? `接口返回摘要：${data.raw.slice(0, 300)}` : "",
      data.upstreamRaw ? `模型原始返回：${data.upstreamRaw.slice(0, 300)}` : "",
    ].filter(Boolean);
    throw new Error(parts.join("\n"));
  }
  if (!data.content) {
    throw new Error(`模型接口响应成功，但没有返回可展示内容。\n接口返回摘要：${raw.slice(0, 300)}`);
  }
  return stripThinking(data.content);
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

function ScorePanel({ scores, onScore, readOnly = false, openAll = false }: {
  scores: Record<string, number | null>;
  onScore?: (id: string, score: number) => void;
  readOnly?: boolean;
  openAll?: boolean;
}) {
  const calc = calculateScores(scores);
  return (
    <div className="score-stack">
      {dimensions.map((dimension, index) => (
        <details className="dimension" key={dimension.id} open={openAll || index === 0}>
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
                      disabled={readOnly}
                      onClick={() => onScore?.(criterion.id, value)} title={`${value} 分`}>{value}</button>
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
  const [originalImage, setOriginalImage] = useState("");
  const [answer, setAnswer] = useState("");
  const [knowledgePoints, setKnowledgePoints] = useState("");
  const [solutionAnalysis, setSolutionAnalysis] = useState("");
  const [errorAnalysis, setErrorAnalysis] = useState("");
  const [importedProblems, setImportedProblems] = useState<ProblemInput[]>([]);
  const [selectedProblemIndex, setSelectedProblemIndex] = useState(-1);
  const [importMessage, setImportMessage] = useState("");
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
  const [experiments, setExperiments] = useState<ExperimentSnapshot[]>([]);
  const stopRef = useRef(false);
  const messagesRef = useRef(messages);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, running]);

  const manualCalc = useMemo(() => calculateScores(scores), [scores]);
  const problemContext = useMemo(() => [
    `题目：${question.trim()}`,
    imageReferenceForModel(originalImage) && `原图：${imageReferenceForModel(originalImage)}`,
    answer.trim() && `参考答案：${answer.trim()}`,
    knowledgePoints.trim() && `知识点：${knowledgePoints.trim()}`,
    solutionAnalysis.trim() && `参考解析：${solutionAnalysis.trim()}`,
    errorAnalysis.trim() && `常见错因分析：${errorAnalysis.trim()}`,
  ].filter(Boolean).join("\n\n"), [question, originalImage, answer, knowledgePoints, solutionAnalysis, errorAnalysis]);

  const validate = (config?: ModelConfig) => {
    if (!question.trim()) throw new Error("请先输入题目。");
    if (config && (!config.endpoint.trim() || !config.model.trim())) throw new Error("请填写对应模型的 API 地址和模型名称。");
  };

  const problemSetters: Record<keyof ProblemInput, (value: string) => void> = {
    question: setQuestion,
    originalImage: setOriginalImage,
    answer: setAnswer,
    knowledgePoints: setKnowledgePoints,
    solutionAnalysis: setSolutionAnalysis,
    errorAnalysis: setErrorAnalysis,
  };

  const updateProblemField = (field: keyof ProblemInput, value: string) => {
    problemSetters[field](value);
    if (selectedProblemIndex >= 0) {
      setImportedProblems((items) => items.map((item, index) =>
        index === selectedProblemIndex ? { ...item, [field]: value } : item
      ));
    }
  };

  const loadProblem = (problem: ProblemInput, index: number) => {
    setSelectedProblemIndex(index);
    setQuestion(problem.question);
    setOriginalImage(problem.originalImage);
    setAnswer(problem.answer);
    setKnowledgePoints(problem.knowledgePoints);
    setSolutionAnalysis(problem.solutionAnalysis);
    setErrorAnalysis(problem.errorAnalysis);
    setMessages([]);
    messagesRef.current = [];
    setDialogueFinished(false);
    setAutoEval(null);
    setScores(emptyScores());
    setTags([]);
    setNotes("");
  };

  const importExcel = async (file: File) => {
    setError("");
    setImportMessage("");
    try {
      const rows = await readSheet(file);
      if (rows.length < 2) throw new Error("表格中没有可导入的数据行。");
      const headers = rows[0].map((cell) => String(cell ?? "").trim().replace(/\s+/g, ""));
      const fieldIndexes = Object.fromEntries(
        Object.entries(excelHeaderAliases).map(([field, aliases]) => [
          field,
          headers.findIndex((header) => aliases.includes(header)),
        ]),
      ) as Record<keyof ProblemInput, number>;
      if (Object.values(fieldIndexes).every((index) => index < 0)) {
        throw new Error("没有识别到题目字段。请使用列名：题目、原图、答案、知识点、解析、错因分析。");
      }
      const valueAt = (row: readonly unknown[], index: number) =>
        index < 0 || row[index] === null || row[index] === undefined ? "" : String(row[index]).trim();
      const problems = rows.slice(1).map((row) => ({
        question: valueAt(row, fieldIndexes.question),
        originalImage: valueAt(row, fieldIndexes.originalImage),
        answer: valueAt(row, fieldIndexes.answer),
        knowledgePoints: valueAt(row, fieldIndexes.knowledgePoints),
        solutionAnalysis: valueAt(row, fieldIndexes.solutionAnalysis),
        errorAnalysis: valueAt(row, fieldIndexes.errorAnalysis),
      })).filter((problem) => Object.values(problem).some(Boolean));
      if (!problems.length) throw new Error("表格中没有非空的题目数据。");
      setImportedProblems(problems);
      loadProblem(problems[0], 0);
      setImportMessage(`已导入 ${problems.length} 道题，当前显示第 1 题。`);
    } catch (e) {
      setError(e instanceof Error ? `Excel 导入失败：${e.message}` : "Excel 导入失败。");
    } finally {
      if (excelInputRef.current) excelInputRef.current.value = "";
    }
  };

  const importImageFile = (file: File) => {
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("原图上传失败：请选择图片文件。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      updateProblemField("originalImage", typeof reader.result === "string" ? reader.result : "");
      setNotice("原图已上传并可在页面预览。");
      if (imageInputRef.current) imageInputRef.current.value = "";
    };
    reader.onerror = () => setError("原图上传失败：无法读取这个图片文件。");
    reader.readAsDataURL(file);
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
      const requiredScoreKeys = dimensions.flatMap((dimension) => dimension.criteria.map((criterion) => criterion.id));
      const compactRubric = dimensions.map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        weight: dimension.weight,
        criteria: dimension.criteria.map((criterion) => ({
          id: criterion.id,
          name: criterion.name,
        })),
      }));
      const outputTemplate = {
        scores: Object.fromEntries(requiredScoreKeys.map((key) => [key, 0])),
        errorTags: [],
        deductions: ["用一句话说明具体扣分原因"],
        suggestions: ["用一句话说明可执行的改进建议"],
        summary: "用一到两句话总结本轮讲题质量",
      };
      const payload = {
        problem: {
          question,
          originalImage: imageReferenceForModel(originalImage),
          answer,
          knowledgePoints,
          solutionAnalysis,
          errorAnalysis,
        },
        dialogue: messages.map((m) => ({
          turn: m.turn,
          role: m.role === "teacher" ? "AI老师" : "学生",
          content: m.content,
        })),
        rubric: compactRubric,
        outputContract: {
          requiredScoreKeys,
          allowedErrorTags: errorTags,
          outputTemplate,
        },
      };
      const raw = await callModel(judge, [
        { role: "system", content: `${judge.prompt}\n\n请快速完成评分，输出必须简短。deductions 和 suggestions 各最多 5 条，每条不超过 40 个汉字。` },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ], true, 1200);
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

  const redactedConfig = (config: ModelConfig): ModelConfig => ({
    ...config,
    apiKey: config.apiKey ? "[REDACTED]" : "",
  });

  const exportState = (exportedAt = new Date().toISOString()): EvaluationExportState => ({
    session: { id: sessionId, createdAt, exportedAt, version: "1.1" },
    problem: { question, originalImage, answer, knowledgePoints, solutionAnalysis, errorAnalysis },
    configurations: {
      student: redactedConfig(student),
      teacher: redactedConfig(teacher),
      judge: redactedConfig(judge),
    },
    dialogue: {
      maxMessages: MAX_MESSAGES,
      completed: dialogueFinished,
      messages,
    },
    manualEvaluation: { scores, ...manualCalc, errorTags: tags, notes },
    autoEvaluation: autoEval,
  });

  const saveExperiment = () => {
    const savedAt = new Date().toISOString();
    const state = exportState(savedAt);
    const snapshot: ExperimentSnapshot = {
      id: state.session.id,
      savedAt,
      title: question.trim().slice(0, 26) || "未命名题目",
      state,
    };
    setExperiments((prev) => [...prev, snapshot]);
    setNotice(`已保存第 ${experiments.length + 1} 次实验，可继续换题或重跑。`);
  };

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
      ["problem", "originalImage", originalImage],
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

  const exportExperimentsExcel = () => {
    const now = new Date().toISOString();
    const snapshots = experiments.length
      ? experiments
      : [{
        id: sessionId,
        savedAt: now,
        title: question.trim().slice(0, 26) || "当前实验",
        state: exportState(now),
      }];
    const workbook = XLSX.utils.book_new();
    const summaryRows: Array<Array<string | number>> = [[
      "实验序号", "Session ID", "保存时间", "题目", "答案", "知识点", "对话条数",
      "原图", "对话是否完成", "人工总分", "人工是否通过", "自动总分", "自动是否通过", "错误标签", "人工备注",
    ]];
    const scoreRows: Array<Array<string | number>> = [[
      "实验序号", "Session ID", "评分来源", "一级维度", "一级权重", "一级小计",
      "二级维度 ID", "二级维度", "二级分数",
    ]];
    const dialogueRows: Array<Array<string | number>> = [[
      "实验序号", "Session ID", "轮次", "角色", "模型", "API 地址", "时间", "消息内容", "Prompt 快照",
    ]];
    const detailRows: Array<Array<string | number>> = [[
      "实验序号", "Session ID", "类型", "字段", "内容",
    ]];

    snapshots.forEach((snapshot, index) => {
      const state = snapshot.state;
      summaryRows.push([
        index + 1,
        state.session.id,
        snapshot.savedAt,
        state.problem.question,
        state.problem.answer,
        state.problem.knowledgePoints,
        state.dialogue.messages.length,
        state.problem.originalImage,
        state.dialogue.completed ? "是" : "否",
        state.manualEvaluation.total,
        state.manualEvaluation.passed ? "是" : "否",
        state.autoEvaluation?.parseError ? "解析失败" : state.autoEvaluation?.total ?? "",
        state.autoEvaluation?.parseError ? "否" : state.autoEvaluation?.passed ? "是" : state.autoEvaluation ? "否" : "",
        state.manualEvaluation.errorTags.join("；"),
        state.manualEvaluation.notes,
      ]);

      const pushScores = (source: "人工评分" | "自动评分", scores: Record<string, number | null>, subtotals: Record<string, number>) => {
        dimensions.forEach((dimension) => {
          dimension.criteria.forEach((criterion) => {
            const value = scores[criterion.id];
            scoreRows.push([
              index + 1,
              state.session.id,
              source,
              dimension.name,
              dimension.weight,
              subtotals[dimension.id] ?? "",
              criterion.id,
              criterion.name,
              value === null || value === undefined ? "" : value,
            ]);
          });
        });
      };
      pushScores("人工评分", state.manualEvaluation.scores, state.manualEvaluation.subtotals);
      if (state.autoEvaluation && !state.autoEvaluation.parseError) {
        pushScores("自动评分", state.autoEvaluation.scores, state.autoEvaluation.subtotals);
      }

      state.dialogue.messages.forEach((message) => {
        dialogueRows.push([
          index + 1,
          state.session.id,
          message.turn,
          message.role === "teacher" ? "AI 老师" : "学生",
          message.model,
          message.modelApi,
          message.timestamp,
          message.content,
          message.promptSnapshot,
        ]);
      });

      detailRows.push(
        [index + 1, state.session.id, "题目", "原图", state.problem.originalImage],
        [index + 1, state.session.id, "题目", "解析", state.problem.solutionAnalysis],
        [index + 1, state.session.id, "题目", "错因分析", state.problem.errorAnalysis],
        [index + 1, state.session.id, "配置", "学生模型", JSON.stringify(state.configurations.student)],
        [index + 1, state.session.id, "配置", "AI 老师模型", JSON.stringify(state.configurations.teacher)],
        [index + 1, state.session.id, "配置", "Judge 模型", JSON.stringify(state.configurations.judge)],
        [index + 1, state.session.id, "自动评分", "错误标签", state.autoEvaluation?.errorTags.join("；") ?? ""],
        [index + 1, state.session.id, "自动评分", "扣分原因", state.autoEvaluation?.deductions.join("\n") ?? ""],
        [index + 1, state.session.id, "自动评分", "改进建议", state.autoEvaluation?.suggestions.join("\n") ?? ""],
        [index + 1, state.session.id, "自动评分", "总结", state.autoEvaluation?.summary ?? ""],
        [index + 1, state.session.id, "自动评分", "原始输出", state.autoEvaluation?.rawOutput ?? ""],
        [index + 1, state.session.id, "自动评分", "解析错误", state.autoEvaluation?.parseError ?? ""],
      );
    });

    const appendSheet = (name: string, rows: Array<Array<string | number>>) => {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = rows[0].map((_, columnIndex) => ({
        wch: Math.min(60, Math.max(10, ...rows.slice(0, 80).map((row) => String(row[columnIndex] ?? "").length + 2))),
      }));
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    };
    appendSheet("实验汇总", summaryRows);
    appendSheet("二级评分明细", scoreRows);
    appendSheet("对话记录", dialogueRows);
    appendSheet("配置与原始输出", detailRows);
    XLSX.writeFile(workbook, `math-evaluation-experiments-${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (!experiments.length) setNotice("还没有保存实验，已先导出当前这一轮。");
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">评</span><div><b>讲题评测平台</b><small>双模型小学数学讲题评测</small></div></div>
        <div className="session-chip"><span /> SESSION <b>{sessionId.slice(0, 8).toUpperCase()}</b></div>
        <div className="header-actions">
          <button className="ghost" onClick={reset}>↻ 重置</button>
          <button className="ghost" onClick={saveExperiment}>＋ 保存本次实验</button>
          <button className="export" onClick={exportExperimentsExcel}>⇩ 导出全部 Excel{experiments.length ? `（${experiments.length}）` : ""}</button>
          <button className="icon-btn" onClick={exportJson} title="导出当前 JSON">JSON</button>
          <button className="icon-btn" onClick={exportCsv} title="导出 CSV">CSV</button>
        </div>
      </header>

      {(error || notice) && <div className={`toast ${error ? "error" : ""}`}><span>{error ? "!" : "✓"}</span>{error || notice}<button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}

      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-heading"><div><small>01 / CONFIGURE</small><h2>题目与模型</h2></div><span className="step-pill">配置</span></div>
          <div className="input-source-bar">
            <div><b>题目输入</b><small>在线填写或批量导入</small></div>
            <input ref={excelInputRef} className="file-input" type="file" accept=".xlsx"
              onChange={(e) => e.target.files?.[0] && importExcel(e.target.files[0])} />
            <button onClick={() => excelInputRef.current?.click()}>↑ 上传 Excel</button>
          </div>
          <p className="excel-hint">首行列名：题目、原图、答案、知识点、解析、错因分析；允许部分单元格为空。原图列请放图片 URL 或 data URL，暂不解析 Excel 内嵌图片对象。</p>
          {importedProblems.length > 0 && (
            <label className="problem-selector">已导入题目
              <select value={selectedProblemIndex} onChange={(e) => {
                const index = Number(e.target.value);
                loadProblem(importedProblems[index], index);
                setImportMessage(`已切换到第 ${index + 1} 题。`);
              }}>
                {importedProblems.map((problem, index) => (
                  <option key={index} value={index}>
                    {index + 1}. {problem.question || "题目待补充"}
                  </option>
                ))}
              </select>
              {importMessage && <span>{importMessage}</span>}
            </label>
          )}
          <label className="question-box">题目文本
            <textarea value={question} onChange={(e) => updateProblemField("question", e.target.value)} rows={4} placeholder="在这里输入一道小学数学题…" />
            <span>{question.length} 字</span>
          </label>
          <div className="problem-extras">
            <section className="image-input-card">
              <div className="image-input-head">
                <div><b>题目原图</b><small>可选，支持上传图片或填写图片链接</small></div>
                <input ref={imageInputRef} className="file-input" type="file" accept="image/*"
                  onChange={(e) => e.target.files?.[0] && importImageFile(e.target.files[0])} />
                <button type="button" onClick={() => imageInputRef.current?.click()}>上传原图</button>
              </div>
              <label>原图地址 / Data URL
                <input value={originalImage} onChange={(e) => updateProblemField("originalImage", e.target.value)}
                  placeholder="可选：粘贴图片 URL，或点击上传原图自动生成" />
              </label>
              {originalImage.trim() && (
                isPreviewableImage(originalImage) ? (
                  <figure className="problem-image-preview">
                    <img src={originalImage} alt="题目原图预览" />
                    <figcaption>原图预览</figcaption>
                  </figure>
                ) : (
                  <p className="image-text-preview">已填写原图内容，但不是可直接预览的图片链接。</p>
                )
              )}
            </section>
            <label>参考答案
              <textarea value={answer} onChange={(e) => updateProblemField("answer", e.target.value)} rows={2} placeholder="可选，例如：4 颗" />
            </label>
            <label>知识点
              <input value={knowledgePoints} onChange={(e) => updateProblemField("knowledgePoints", e.target.value)} placeholder="可选，例如：平均分、表内除法" />
            </label>
            <label>参考解析
              <textarea value={solutionAnalysis} onChange={(e) => updateProblemField("solutionAnalysis", e.target.value)} rows={3} placeholder="可选，填写标准解题过程" />
            </label>
            <label>错因分析
              <textarea value={errorAnalysis} onChange={(e) => updateProblemField("errorAnalysis", e.target.value)} rows={3} placeholder="可选，填写常见错误及其原因" />
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
          <div className="experiment-strip">
            <span>已保存实验 <b>{experiments.length}</b> 次</span>
            <button onClick={saveExperiment}>保存当前</button>
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
                    <div className="score-guide"><span>0 异常</span><span>1–2 严重</span><span>3 普通</span><span>4 较好</span><span>5 优秀</span></div>
                    <div className="auto-summary"><span>参考总分</span><b>{autoEval.total}<small> / 100</small></b><em className={autoEval.passed ? "pass" : "fail"}>{autoEval.passed ? "达到基线" : "未达 80 分基线"}</em></div>
                    {autoEval.summary && <p className="judge-summary">{autoEval.summary}</p>}
                    <ScorePanel scores={autoEval.scores} readOnly openAll />
                    <section className="feedback-section auto-tags">
                      <h3>错误标签 <small>Judge 参考</small></h3>
                      <div className="tags">
                        {(autoEval.errorTags.length ? autoEval.errorTags : ["暂无错误标签"]).map((tag) => (
                          <button key={tag} className={autoEval.errorTags.includes(tag) ? "selected" : ""} disabled>{tag}</button>
                        ))}
                      </div>
                    </section>
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
