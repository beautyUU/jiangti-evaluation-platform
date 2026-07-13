export type Criterion = { id: string; name: string; hint: string };
export type Dimension = { id: string; name: string; weight: number; color: string; criteria: Criterion[] };

export const dimensions: Dimension[] = [
  {
    id: "correctness", name: "题意理解与数学正确性", weight: 30, color: "#5d71d8",
    criteria: [
      { id: "problem_understanding", name: "题意理解", hint: "准确提取条件与问题" },
      { id: "concept_identification", name: "考点识别", hint: "识别核心数学知识" },
      { id: "solution_correctness", name: "解法正确性", hint: "过程与方法数学正确" },
      { id: "answer_correctness", name: "答案正确性", hint: "结论完整且准确" },
    ],
  },
  {
    id: "content", name: "讲题内容质量", weight: 25, color: "#d8955d",
    criteria: [
      { id: "step_completeness", name: "步骤完整性", hint: "关键步骤无跳跃" },
      { id: "logical_clarity", name: "逻辑清晰度", hint: "前后衔接清楚" },
      { id: "child_comprehensibility", name: "小学生可理解性", hint: "用词和例子贴近儿童" },
      { id: "pitfall_reminders", name: "易错点提醒", hint: "提示常见误区" },
      { id: "conciseness", name: "讲解简洁度", hint: "重点突出、不冗余" },
    ],
  },
  {
    id: "interaction", name: "交互问答能力", weight: 20, color: "#4aa88e",
    criteria: [
      { id: "followup_understanding", name: "追问理解", hint: "抓住学生真正疑问" },
      { id: "context_retention", name: "上下文保持", hint: "多轮信息一致" },
      { id: "correction_clarification", name: "纠错与澄清", hint: "及时纠正并解释" },
      { id: "emotional_support", name: "情绪支持", hint: "耐心、鼓励、不施压" },
    ],
  },
  {
    id: "flow", name: "流程控制与多轮稳定性", weight: 15, color: "#b16491",
    criteria: [
      { id: "interruption_response", name: "打断响应", hint: "自然处理学生插话" },
      { id: "position_recovery", name: "位置恢复", hint: "回答后回到原讲解" },
      { id: "instruction_following", name: "控制指令执行", hint: "重讲、换法等执行准确" },
    ],
  },
  {
    id: "voice", name: "语音表现与儿童友好性", weight: 10, color: "#5c9aba",
    criteria: [
      { id: "pronunciation", name: "发音准确", hint: "按文本预估朗读准确性" },
      { id: "pace_rhythm", name: "语速节奏", hint: "句长和停顿适宜" },
      { id: "natural_tone", name: "语气自然", hint: "像真实耐心的老师" },
      { id: "emphasis", name: "重点突出", hint: "重点易被听出" },
      { id: "smooth_switching", name: "切换平滑", hint: "话题与方法过渡自然" },
    ],
  },
];

export const errorTags = [
  "数学答案错误", "解法错误", "题意理解错误", "步骤跳步", "解释太成人化",
  "易错点提醒不足", "没有回答学生追问", "上下文丢失", "打断处理失败",
  "流程控制失败", "语言不适合小学生", "回答过长", "重复啰嗦", "没有鼓励学生",
];

export const defaultStudentPrompt = `你是一名真实的小学生，正在听老师讲一道数学题。
请只根据老师刚才的讲解，做出一句自然、简短的反馈或追问。你可以说没听懂、追问某一步、要求重讲或换方法，也可以在真正理解后明确说“我懂了”。
不要自己完整解题，不要直接给答案，不要像老师或成年人一样说话，不要跑题。每次只聚焦一个疑问。
不要输出思考过程、推理草稿、分析过程或任何 <think>...</think> 内容，只输出学生要说的话。`;

export const defaultTeacherPrompt = `你是一位耐心、严谨的小学数学老师。请围绕题目给小学生讲解。
先理解题意和思路，再分步讲解；不要只报答案，不跳步，不堆公式。使用儿童能理解的短句、具体例子和适度鼓励。
认真响应学生的追问、打断、重讲或换方法请求；回答追问后自然回到原讲解位置。学生仍不会时，降低难度并换一种表达。
不要输出思考过程、推理草稿、分析过程或任何 <think>...</think> 内容，只输出老师要说的话。`;

export const defaultJudgePrompt = `你是严格的小学数学讲题质量评审。请根据题目、完整师生对话和评分标准独立评分。
每个二级维度只给 0 到 5 的整数：0=异常/完全缺失，1-2=严重问题，3=普通问题，4=较好，5=优秀。
只输出合法 JSON，不要 Markdown 代码块，不要输出思考过程或 <think> 标签。必须包含 scores（以给定 criterion id 为键）、errorTags（字符串数组）、deductions（字符串数组）、suggestions（字符串数组）和 summary（字符串）。`;

export const emptyScores = () =>
  Object.fromEntries(dimensions.flatMap((d) => d.criteria.map((c) => [c.id, null]))) as Record<string, number | null>;

export function calculateScores(scores: Record<string, number | null>) {
  const subtotals: Record<string, number> = {};
  let total = 0;
  let completed = true;
  for (const d of dimensions) {
    const values = d.criteria.map((c) => scores[c.id]);
    if (values.some((v) => v === null || v === undefined)) completed = false;
    const sum = values.reduce<number>((acc, value) => acc + (typeof value === "number" ? value : 0), 0);
    const subtotal = (sum / (d.criteria.length * 5)) * d.weight;
    subtotals[d.id] = Math.round(subtotal * 10) / 10;
    total += subtotal;
  }
  return { subtotals, total: Math.round(total * 10) / 10, completed, passed: completed && total >= 80 };
}

export const rubricForPrompt = dimensions.map((d) => ({
  id: d.id, name: d.name, weight: d.weight,
  criteria: d.criteria.map((c) => ({ id: c.id, name: c.name, hint: c.hint })),
}));
