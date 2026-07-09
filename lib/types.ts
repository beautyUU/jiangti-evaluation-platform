export type ModelConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
};

export type DialogueMessage = {
  id: string;
  role: "teacher" | "student";
  content: string;
  modelApi: string;
  model: string;
  promptSnapshot: string;
  turn: number;
  timestamp: string;
};

export type AutoEvaluation = {
  scores: Record<string, number | null>;
  subtotals: Record<string, number>;
  total: number;
  passed: boolean;
  errorTags: string[];
  deductions: string[];
  suggestions: string[];
  summary?: string;
  rawOutput: string;
  parseError?: string;
  timestamp: string;
};
