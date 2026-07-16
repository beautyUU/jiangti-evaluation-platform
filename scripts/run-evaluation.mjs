#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_MESSAGES = 20;
const FINAL_TEACHER_TURN = 19;
const DEFAULT_MODEL_TIMEOUT_MS = 30 * 60 * 1000;

const dimensions = [
  {
    id: "correctness", name: "题意理解与数学正确性", weight: 30,
    criteria: [
      { id: "problem_understanding", name: "题意理解" },
      { id: "concept_identification", name: "考点识别" },
      { id: "solution_correctness", name: "解法正确性" },
      { id: "answer_correctness", name: "答案正确性" },
    ],
  },
  {
    id: "content", name: "讲题内容质量", weight: 25,
    criteria: [
      { id: "step_completeness", name: "步骤完整性" },
      { id: "logical_clarity", name: "逻辑清晰度" },
      { id: "child_comprehensibility", name: "小学生可理解性" },
      { id: "pitfall_reminders", name: "易错点提醒" },
      { id: "conciseness", name: "讲解简洁度" },
    ],
  },
  {
    id: "interaction", name: "交互问答能力", weight: 20,
    criteria: [
      { id: "followup_understanding", name: "追问理解" },
      { id: "context_retention", name: "上下文保持" },
      { id: "correction_clarification", name: "纠错与澄清" },
      { id: "emotional_support", name: "情绪支持" },
    ],
  },
  {
    id: "flow", name: "流程控制与多轮稳定性", weight: 15,
    criteria: [
      { id: "interruption_response", name: "打断响应" },
      { id: "position_recovery", name: "位置恢复" },
      { id: "instruction_following", name: "控制指令执行" },
    ],
  },
  {
    id: "voice", name: "语音表现与儿童友好性", weight: 10,
    criteria: [
      { id: "pronunciation", name: "发音准确" },
      { id: "pace_rhythm", name: "语速节奏" },
      { id: "natural_tone", name: "语气自然" },
      { id: "emphasis", name: "重点突出" },
      { id: "smooth_switching", name: "切换平滑" },
    ],
  },
];

const errorTags = [
  "数学答案错误", "解法错误", "题意理解错误", "步骤跳步", "解释太成人化",
  "易错点提醒不足", "没有回答学生追问", "上下文丢失", "打断处理失败",
  "流程控制失败", "语言不适合小学生", "回答过长", "重复啰嗦", "没有鼓励学生",
];

const defaultStudentPrompt = `你是一名真实的小学生，正在听老师讲一道数学题。
请只根据老师刚才的讲解，做出一句自然、简短的反馈或追问。你可以说没听懂、追问某一步、要求重讲或换方法，也可以在真正理解后明确说“我懂了”。
不要自己完整解题，不要直接给答案，不要像老师或成年人一样说话，不要跑题。每次只聚焦一个疑问。
不要输出思考过程、推理草稿、分析过程或任何 <think>...</think> 内容，只输出学生要说的话。`;

const defaultTeacherPrompt = `你是一位耐心、严谨的小学数学老师。请围绕题目给小学生讲解。
先理解题意和思路，再分步讲解；不要只报答案，不跳步，不堆公式。使用儿童能理解的短句、具体例子和适度鼓励。
认真响应学生的追问、打断、重讲或换方法请求；回答追问后自然回到原讲解位置。学生仍不会时，降低难度并换一种表达。
不要输出思考过程、推理草稿、分析过程或任何 <think>...</think> 内容，只输出老师要说的话。`;

const defaultJudgePrompt = `你是严格的小学数学讲题质量评审。你会收到题目、完整师生对话和评分标准。
每个二级维度只给 0 到 5 的整数：0=异常/完全缺失，1-2=严重问题，3=普通问题，4=较好，5=优秀。
只输出合法 JSON，不要 Markdown，不要思考过程。scores 必须包含所有 criterion id。`;

const aliases = {
  serialNumber: ["序号", "编号", "题号", "ID", "id", "No", "NO", "no", "序列号"],
  question: ["题目", "题干", "题目文本", "问题"],
  originalImage: ["原图", "图片", "题图", "题目图片", "图片链接", "原图链接", "image", "imageUrl", "imageURL"],
  answer: ["答案", "参考答案", "标准答案"],
  knowledgePoints: ["知识点", "考点", "涉及知识点"],
  solutionAnalysis: ["解析", "参考解析", "答案解析", "解题过程", "解法"],
  errorAnalysis: ["错因分析", "错因", "错误原因", "常见错因"],
};

function parseArgs(argv) {
  const args = { maxMessages: DEFAULT_MAX_MESSAGES, limit: Infinity, judge: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--max-messages") args.maxMessages = Number(argv[++i]);
    else if (arg === "--no-judge") args.judge = false;
    else if (arg === "--teacher-model") args.teacherModel = argv[++i];
    else if (arg === "--student-model") args.studentModel = argv[++i];
    else if (arg === "--judge-model") args.judgeModel = argv[++i];
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function help() {
  return `用法：
  npm run evaluate -- --input ./questions.xlsx --output ./outputs/result.json

常用参数：
  --input <xlsx>          题目 Excel
  --output <json>         输出 JSON 路径，默认 outputs/evaluation-时间戳.json
  --limit <n>             只跑前 n 道题
  --max-messages <n>      每题最多对话条数，默认 20
  --no-judge              只跑师生对话，不跑自动评分

环境变量：
  TEACHER_API_KEY / TEACHER_MODEL / TEACHER_ENDPOINT
  STUDENT_API_KEY / STUDENT_MODEL / STUDENT_ENDPOINT
  JUDGE_API_KEY / JUDGE_MODEL / JUDGE_ENDPOINT

如果三者共用同一个接口，也可以只填：
  MODEL_API_KEY / MODEL_NAME / MODEL_ENDPOINT
`;
}

function modelConfig(prefix, fallbackPrompt, explicitModel) {
  const common = {
    endpoint: process.env.MODEL_ENDPOINT || DEFAULT_ENDPOINT,
    apiKey: process.env.MODEL_API_KEY || "",
    model: process.env.MODEL_NAME || "",
  };
  return {
    endpoint: process.env[`${prefix}_ENDPOINT`] || common.endpoint,
    apiKey: process.env[`${prefix}_API_KEY`] || common.apiKey,
    model: explicitModel || process.env[`${prefix}_MODEL`] || common.model,
    prompt: process.env[`${prefix}_PROMPT`] || fallbackPrompt,
  };
}

function normalizeEndpoint(value) {
  const trimmed = String(value || "").trim().replace(/\/$/, "");
  if (!trimmed) return trimmed;
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function stripThinking(raw) {
  return String(raw || "")
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

async function callModel(config, messages, { temperature = 0.7, maxTokens } = {}) {
  if (!config.endpoint || !config.model) throw new Error("模型 endpoint/model 未配置。");
  const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS);
  const response = await fetch(normalizeEndpoint(config.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MODEL_TIMEOUT_MS),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`模型返回非 JSON（HTTP ${response.status}）：${raw.slice(0, 500)}`);
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.message || raw;
    throw new Error(`模型调用失败（HTTP ${response.status}）：${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`模型响应缺少 choices[0].message.content：${raw.slice(0, 500)}`);
  return stripThinking(content);
}

function readProblems(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (rows.length < 2) return [];
  const headers = rows[0].map((cell) => String(cell ?? "").trim().replace(/\s+/g, ""));
  const indexOf = (field) => headers.findIndex((header) => aliases[field].includes(header));
  const indexes = Object.fromEntries(Object.keys(aliases).map((field) => [field, indexOf(field)]));
  const valueAt = (row, index) => index < 0 ? "" : String(row[index] ?? "").trim();
  return rows.slice(1).map((row, index) => ({
    serialNumber: valueAt(row, indexes.serialNumber) || String(index + 1),
    question: valueAt(row, indexes.question),
    originalImage: valueAt(row, indexes.originalImage),
    answer: valueAt(row, indexes.answer),
    knowledgePoints: valueAt(row, indexes.knowledgePoints),
    solutionAnalysis: valueAt(row, indexes.solutionAnalysis),
    errorAnalysis: valueAt(row, indexes.errorAnalysis),
  })).filter((problem) => Object.values(problem).some(Boolean));
}

function imageReferenceForModel(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^data:image\//i.test(trimmed)) return "已上传题目原图；脚本评测仅传递文字题目与参考信息。";
  return trimmed;
}

function problemContext(problem) {
  return [
    problem.serialNumber && `序号：${problem.serialNumber}`,
    problem.question && `题目：${problem.question}`,
    imageReferenceForModel(problem.originalImage) && `原图：${imageReferenceForModel(problem.originalImage)}`,
    problem.answer && `参考答案：${problem.answer}`,
    problem.knowledgePoints && `知识点：${problem.knowledgePoints}`,
    problem.solutionAnalysis && `参考解析：${problem.solutionAnalysis}`,
    problem.errorAnalysis && `常见错因分析：${problem.errorAnalysis}`,
  ].filter(Boolean).join("\n\n");
}

function historyFor(role, history) {
  return history.map((message) => ({
    role: message.role === role ? "assistant" : "user",
    content: `${message.role === "teacher" ? "AI 老师" : "学生"}：${message.content}`,
  }));
}

function isStudentDone(text) {
  return /我懂了|明白了|会了|听懂了|原来如此|懂啦/.test(text) && !/不懂|没懂|不会|还是/.test(text);
}

async function runDialogue(problem, configs, maxMessages) {
  const messages = [];
  const context = problemContext(problem);
  while (messages.length < maxMessages) {
    const role = messages.length % 2 === 0 ? "teacher" : "student";
    const config = role === "teacher" ? configs.teacher : configs.student;
    const studentJustUnderstood =
      role === "teacher" &&
      messages.at(-1)?.role === "student" &&
      isStudentDone(messages.at(-1)?.content ?? "");
    const mustConclude = role === "teacher" && (messages.length + 1 >= Math.min(FINAL_TEACHER_TURN, maxMessages - 1) || studentJustUnderstood);
    const task = role === "teacher"
      ? messages.length === 0
        ? `${context}\n\n这是对话第一条消息。请开始讲解，先确认题意，再讲第一步。参考信息仅用于保证讲解准确，不要生硬照读。`
        : mustConclude
          ? `${context}\n\n现在必须结束本题讲解。请结合此前对话，完整补齐关键步骤，明确写出算式、推理过程和最终答案，再用一句适合小学生的话总结。`
          : `${context}\n\n请根据学生最新反馈继续讲解。只输出老师本轮要说的话。`
      : `${context}\n\n请根据老师最新讲解，以小学生身份自然回应。只输出学生本轮要说的话。不要直接复述答案。`;
    const content = await callModel(config, [
      { role: "system", content: config.prompt },
      ...historyFor(role, messages),
      { role: "user", content: task },
    ]);
    const next = {
      turn: messages.length + 1,
      role,
      content,
      model: config.model,
      modelApi: normalizeEndpoint(config.endpoint),
      promptSnapshot: config.prompt,
      timestamp: new Date().toISOString(),
    };
    messages.push(next);
    console.log(`  ${next.turn}. ${role === "teacher" ? "老师" : "学生"} ✓`);
    if (next.role === "teacher" && (mustConclude || studentJustUnderstood)) break;
  }
  return messages;
}

function cleanJson(raw) {
  const text = stripThinking(raw).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function emptyScores() {
  return Object.fromEntries(dimensions.flatMap((dimension) => dimension.criteria.map((criterion) => [criterion.id, null])));
}

function calculateScores(scores) {
  const subtotals = {};
  let total = 0;
  let completed = true;
  for (const dimension of dimensions) {
    const values = dimension.criteria.map((criterion) => scores[criterion.id]);
    if (values.some((value) => value === null || value === undefined)) completed = false;
    const sum = values.reduce((acc, value) => acc + (typeof value === "number" ? value : 0), 0);
    const subtotal = (sum / (dimension.criteria.length * 5)) * dimension.weight;
    subtotals[dimension.id] = Math.round(subtotal * 10) / 10;
    total += subtotal;
  }
  return { subtotals, total: Math.round(total * 10) / 10, completed, passed: completed && total >= 80 };
}

async function readExistingResults(output) {
  try {
    const raw = await fs.readFile(output, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

async function runJudge(problem, dialogue, config) {
  const requiredScoreKeys = dimensions.flatMap((dimension) => dimension.criteria.map((criterion) => criterion.id));
  const payload = {
    problem: { ...problem, originalImage: imageReferenceForModel(problem.originalImage) },
    dialogue: dialogue.map((message) => ({ turn: message.turn, role: message.role, content: message.content })),
    rubric: dimensions,
    outputContract: {
      requiredScoreKeys,
      allowedErrorTags: errorTags,
      outputTemplate: {
        scores: Object.fromEntries(requiredScoreKeys.map((key) => [key, 0])),
        errorTags: [],
        deductions: ["具体扣分原因"],
        suggestions: ["具体改进建议"],
        summary: "总体评价",
      },
    },
  };
  const raw = await callModel(config, [
    { role: "system", content: `${config.prompt}\n\n只输出 JSON。deductions 和 suggestions 各最多 5 条，每条不超过 40 个汉字。` },
    { role: "user", content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.2, maxTokens: 1200 });
  const parsed = JSON.parse(cleanJson(raw));
  const scores = emptyScores();
  for (const key of Object.keys(scores)) {
    const value = parsed?.scores?.[key];
    scores[key] = typeof value === "number" ? Math.max(0, Math.min(5, Math.round(value))) : null;
  }
  const calc = calculateScores(scores);
  return {
    scores,
    ...calc,
    errorTags: Array.isArray(parsed.errorTags) ? parsed.errorTags.map(String) : [],
    deductions: Array.isArray(parsed.deductions) ? parsed.deductions.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    rawOutput: raw,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(help());
    return;
  }
  if (!args.input) throw new Error("请提供 --input Excel 文件。");

  const input = path.resolve(args.input);
  const output = path.resolve(args.output || `outputs/evaluation-${Date.now()}.json`);
  const configs = {
    teacher: modelConfig("TEACHER", defaultTeacherPrompt, args.teacherModel),
    student: modelConfig("STUDENT", defaultStudentPrompt, args.studentModel),
    judge: modelConfig("JUDGE", defaultJudgePrompt, args.judgeModel),
  };
  const problems = readProblems(input).slice(0, args.limit);
  if (!problems.length) throw new Error("Excel 中没有可评测题目。");
  await fs.mkdir(path.dirname(output), { recursive: true });

  const session = {
    id: `script-${Date.now()}`,
    createdAt: new Date().toISOString(),
    input,
    output,
    maxMessages: args.maxMessages,
  };
  const results = await readExistingResults(output);
  const completedSerials = new Set(
    results
      .filter((item) => item && !item.error && item.problem?.serialNumber)
      .map((item) => String(item.problem.serialNumber)),
  );
  if (completedSerials.size) {
    console.log(`检测到已有 ${completedSerials.size} 道成功结果，将自动跳过。`);
  }
  for (const [index, problem] of problems.entries()) {
    if (completedSerials.has(String(problem.serialNumber))) {
      console.log(`\n[${index + 1}/${problems.length}] 序号 ${problem.serialNumber || index + 1} 已完成，跳过`);
      continue;
    }
    console.log(`\n[${index + 1}/${problems.length}] 序号 ${problem.serialNumber || index + 1}`);
    const item = {
      problem,
      dialogue: [],
      autoEvaluation: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: "",
    };
    try {
      item.dialogue = await runDialogue(problem, configs, args.maxMessages);
      if (args.judge) {
        console.log("  Judge 自动评分…");
        item.autoEvaluation = await runJudge(problem, item.dialogue, configs.judge);
        console.log(`  自动评分 ${item.autoEvaluation.total}/100`);
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      console.error(`  失败：${item.error}`);
    } finally {
      item.finishedAt = new Date().toISOString();
      results.push(item);
      await fs.writeFile(output, JSON.stringify({ session, results }, null, 2), "utf8");
    }
  }
  console.log(`\n完成。结果已写入：${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
