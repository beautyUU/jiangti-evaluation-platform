"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { calculateScores, dimensions, emptyScores, errorTags } from "@/lib/evaluation";
import type { AutoEvaluation } from "@/lib/types";

type Problem = {
  serialNumber?: string;
  question?: string;
  originalImage?: string;
  answer?: string;
  knowledgePoints?: string;
  solutionAnalysis?: string;
  errorAnalysis?: string;
};

type ScriptDialogue = {
  turn: number;
  role: "teacher" | "student";
  content: string;
  model?: string;
  modelApi?: string;
  promptSnapshot?: string;
  timestamp?: string;
};

type ScriptResult = {
  problem: Problem;
  dialogue: ScriptDialogue[];
  autoEvaluation: AutoEvaluation | null;
  error: string | null;
  startedAt?: string;
  finishedAt?: string;
};

type ScriptExport = {
  session?: { id?: string; createdAt?: string; input?: string; output?: string; maxMessages?: number };
  results?: ScriptResult[];
};

type ManualReview = {
  scores: Record<string, number | null>;
  tags: string[];
  notes: string;
};

const reviewStorageKey = "math-dialogue-batch-review-v1";

function isPreviewableImage(value?: string) {
  return /^(https?:\/\/|data:image\/|blob:)/i.test(String(value || "").trim());
}

function problemTitle(problem: Problem, index: number) {
  const serial = problem.serialNumber || String(index + 1);
  const question = String(problem.question || "未填写题目").replace(/\s+/g, " ").slice(0, 42);
  return `${serial}. ${question}`;
}

function scoreBand(total?: number) {
  if (typeof total !== "number") return "未评分";
  if (total >= 90) return "优秀";
  if (total >= 80) return "通过";
  if (total >= 60) return "待改进";
  return "风险高";
}

function downloadBlob(content: string | BlobPart[], name: string, type: string) {
  const blob = Array.isArray(content) ? new Blob(content, { type }) : new Blob(["\ufeff", content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReviewPage() {
  const [data, setData] = useState<ScriptExport | null>(null);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unreviewed" | "failed" | "error">("all");
  const [reviews, setReviews] = useState<Record<string, ManualReview>>({});
  const [notice, setNotice] = useState("");

  const results = data?.results || [];
  const selectedResult = results[selected];
  const reviewKey = selectedResult?.problem?.serialNumber || String(selected);
  const currentReview = reviews[reviewKey] || { scores: emptyScores(), tags: [], notes: "" };
  const manualCalc = calculateScores(currentReview.scores);

  const reviewedCount = useMemo(
    () => Object.values(reviews).filter((review) => calculateScores(review.scores).completed).length,
    [reviews],
  );
  const errorCount = results.filter((item) => item.error).length;
  const avgAuto = useMemo(() => {
    const totals = results.map((item) => item.autoEvaluation?.total).filter((value): value is number => typeof value === "number");
    return totals.length ? Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 10) / 10 : null;
  }, [results]);

  const visibleResults = results
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      const key = item.problem?.serialNumber || String(index);
      const review = reviews[key];
      const completed = review ? calculateScores(review.scores).completed : false;
      const text = `${item.problem?.serialNumber || ""} ${item.problem?.question || ""} ${item.problem?.answer || ""}`.toLowerCase();
      if (query && !text.includes(query.toLowerCase())) return false;
      if (filter === "unreviewed" && completed) return false;
      if (filter === "failed" && (item.autoEvaluation?.total ?? 100) >= 80) return false;
      if (filter === "error" && !item.error) return false;
      return true;
    });

  const updateReview = (patch: Partial<ManualReview>) => {
    setReviews((prev) => ({
      ...prev,
      [reviewKey]: { ...currentReview, ...patch },
    }));
  };

  const loadJson = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as ScriptExport;
    if (!Array.isArray(parsed.results)) throw new Error("这个 JSON 里没有 results 数组，可能不是脚本导出的结果文件。");
    setData(parsed);
    setSelected(0);
    setNotice(`已载入 ${parsed.results.length} 条结果。`);
    const saved = localStorage.getItem(reviewStorageKey);
    if (saved) {
      try {
        setReviews(JSON.parse(saved) as Record<string, ManualReview>);
      } catch {
        setReviews({});
      }
    }
  };

  const saveReview = () => {
    localStorage.setItem(reviewStorageKey, JSON.stringify(reviews));
    setNotice("人工评分已保存到当前浏览器。");
  };

  const applyAuto = () => {
    if (!selectedResult?.autoEvaluation || selectedResult.autoEvaluation.parseError) return;
    updateReview({
      scores: { ...selectedResult.autoEvaluation.scores },
      tags: [...(selectedResult.autoEvaluation.errorTags || [])],
      notes: [
        selectedResult.autoEvaluation.summary,
        ...(selectedResult.autoEvaluation.deductions || []).map((item) => `扣分：${item}`),
        ...(selectedResult.autoEvaluation.suggestions || []).map((item) => `建议：${item}`),
      ].filter(Boolean).join("\n"),
    });
    setNotice("已将自动评分填入当前题的人工评分区，可继续微调。");
  };

  const exportJson = () => {
    downloadBlob(JSON.stringify({ ...data, manualReviews: reviews, exportedAt: new Date().toISOString() }, null, 2), "batch-review-with-manual.json", "application/json;charset=utf-8");
  };

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    const summary = [[
      "序号", "题目", "答案", "知识点", "对话条数", "运行错误", "自动总分", "自动结论", "人工总分", "人工结论", "人工是否完成", "错误标签", "人工备注",
    ]];
    const scores = [[
      "序号", "评分来源", "一级维度", "一级权重", "一级小计", "二级维度 ID", "二级维度", "分数",
    ]];
    const dialogue = [["序号", "轮次", "角色", "模型", "时间", "内容"]];

    results.forEach((item, index) => {
      const key = item.problem?.serialNumber || String(index);
      const review = reviews[key] || { scores: emptyScores(), tags: [], notes: "" };
      const calc = calculateScores(review.scores);
      summary.push([
        item.problem?.serialNumber || String(index + 1),
        item.problem?.question || "",
        item.problem?.answer || "",
        item.problem?.knowledgePoints || "",
        String(item.dialogue?.length || 0),
        item.error || "",
        String(item.autoEvaluation?.total ?? ""),
        scoreBand(item.autoEvaluation?.total),
        String(calc.total),
        scoreBand(calc.total),
        calc.completed ? "是" : "否",
        review.tags.join("；"),
        review.notes,
      ]);

      const pushScoreRows = (source: string, scoreMap: Record<string, number | null>, subtotals: Record<string, number>) => {
        dimensions.forEach((dimension) => {
          dimension.criteria.forEach((criterion) => {
            scores.push([
              item.problem?.serialNumber || String(index + 1),
              source,
              dimension.name,
              String(dimension.weight),
              String(subtotals[dimension.id] ?? ""),
              criterion.id,
              criterion.name,
              scoreMap[criterion.id] === null || scoreMap[criterion.id] === undefined ? "" : String(scoreMap[criterion.id]),
            ]);
          });
        });
      };
      pushScoreRows("人工评分", review.scores, calc.subtotals);
      if (item.autoEvaluation && !item.autoEvaluation.parseError) {
        pushScoreRows("自动评分", item.autoEvaluation.scores, item.autoEvaluation.subtotals || {});
      }

      item.dialogue?.forEach((message) => {
        dialogue.push([
          item.problem?.serialNumber || String(index + 1),
          String(message.turn),
          message.role === "teacher" ? "AI老师" : "学生",
          message.model || "",
          message.timestamp || "",
          message.content,
        ]);
      });
    });

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summary), "汇总");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(scores), "评分明细");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(dialogue), "对话记录");
    XLSX.writeFile(workbook, `batch-review-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <main className="review-page">
      <header className="review-topbar">
        <div>
          <Link href="/">← 返回对话平台</Link>
          <h1>批量结果复评</h1>
          <p>上传脚本导出的 JSON，逐题查看对话、参考自动评分，并补充人工评分。</p>
        </div>
        <label className="review-upload">
          上传结果 JSON
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try { await loadJson(file); }
              catch (error) { setNotice(error instanceof Error ? error.message : "载入失败"); }
            }}
          />
        </label>
      </header>

      {notice && <div className="review-toast">{notice}<button onClick={() => setNotice("")}>×</button></div>}

      {!data ? (
        <section className="review-empty">
          <span>📊</span>
          <h2>先上传脚本结果文件</h2>
          <p>例如 <code>outputs/questions-20260715-full.json</code>。上传后会进入逐题复评界面。</p>
        </section>
      ) : (
        <section className="review-workspace">
          <aside className="review-list">
            <div className="review-stats">
              <div><b>{results.length}</b><span>结果数</span></div>
              <div><b>{reviewedCount}</b><span>已人工评</span></div>
              <div><b>{avgAuto ?? "-"}</b><span>自动均分</span></div>
              <div><b>{errorCount}</b><span>错误</span></div>
            </div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索序号 / 题目 / 答案" />
            <div className="review-filter">
              {[
                ["all", "全部"],
                ["unreviewed", "未人工评"],
                ["failed", "自动低于80"],
                ["error", "运行错误"],
              ].map(([id, label]) => (
                <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id as typeof filter)}>{label}</button>
              ))}
            </div>
            <div className="review-items">
              {visibleResults.map(({ item, index }) => {
                const key = item.problem?.serialNumber || String(index);
                const completed = reviews[key] ? calculateScores(reviews[key].scores).completed : false;
                return (
                  <button key={`${key}-${index}`} className={selected === index ? "active" : ""} onClick={() => setSelected(index)}>
                    <strong>{problemTitle(item.problem || {}, index)}</strong>
                    <span>
                      自动 {item.autoEvaluation?.total ?? "-"} · {item.dialogue?.length || 0} 条
                      {completed ? " · 已人工评" : ""}
                      {item.error ? " · 有错误" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="review-detail">
            {selectedResult && (
              <>
                <div className="review-problem">
                  <div>
                    <small>题目 #{selectedResult.problem?.serialNumber || selected + 1}</small>
                    <h2>{selectedResult.problem?.question || "未填写题目"}</h2>
                  </div>
                  <div className="review-score-card">
                    <span>自动评分</span>
                    <b>{selectedResult.autoEvaluation?.total ?? "-"}</b>
                    <em>{scoreBand(selectedResult.autoEvaluation?.total)}</em>
                  </div>
                </div>

                <div className="review-problem-grid">
                  {isPreviewableImage(selectedResult.problem?.originalImage) && (
                    <figure>
                      <img src={selectedResult.problem?.originalImage} alt="题目原图" />
                      <figcaption>题目原图</figcaption>
                    </figure>
                  )}
                  <div>
                    <h3>参考信息</h3>
                    <p><b>答案：</b>{selectedResult.problem?.answer || "未填写"}</p>
                    <p><b>知识点：</b>{selectedResult.problem?.knowledgePoints || "未填写"}</p>
                    <p><b>解析：</b>{selectedResult.problem?.solutionAnalysis || "未填写"}</p>
                    <p><b>错因：</b>{selectedResult.problem?.errorAnalysis || "未填写"}</p>
                  </div>
                </div>

                {selectedResult.error && <div className="review-error">运行错误：{selectedResult.error}</div>}

                <div className="review-dialogue">
                  <h3>师生对话</h3>
                  {selectedResult.dialogue?.map((message) => (
                    <article key={`${message.turn}-${message.role}`} className={`review-message ${message.role}`}>
                      <div>
                        <b>{message.role === "teacher" ? "AI 老师" : "学生"}</b>
                        <span>第 {message.turn} 条 · {message.model || ""}</span>
                      </div>
                      <p>{message.content}</p>
                    </article>
                  ))}
                </div>

                {selectedResult.autoEvaluation && (
                  <div className="review-auto">
                    <h3>自动评分参考</h3>
                    {selectedResult.autoEvaluation.summary && <p>{selectedResult.autoEvaluation.summary}</p>}
                    {!!selectedResult.autoEvaluation.deductions?.length && (
                      <ul>{selectedResult.autoEvaluation.deductions.map((item, index) => <li key={index}>扣分：{item}</li>)}</ul>
                    )}
                    {!!selectedResult.autoEvaluation.suggestions?.length && (
                      <ul>{selectedResult.autoEvaluation.suggestions.map((item, index) => <li key={index}>建议：{item}</li>)}</ul>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          <aside className="review-score">
            <div className="review-score-head">
              <div><span>人工评分</span><b>{manualCalc.total}</b><small>/100</small></div>
              <em className={manualCalc.passed ? "pass" : "fail"}>{manualCalc.completed ? (manualCalc.passed ? "通过" : "未通过") : "未完成"}</em>
            </div>
            <div className="review-score-actions">
              <button onClick={applyAuto} disabled={!selectedResult?.autoEvaluation || !!selectedResult.autoEvaluation.parseError}>用自动评分填入</button>
              <button onClick={saveReview}>保存人工评分</button>
            </div>
            <div className="review-score-scroll">
              {dimensions.map((dimension) => (
                <details key={dimension.id} open className="dimension">
                  <summary>
                    <span className="dimension-mark" style={{ background: dimension.color }}>{dimension.weight}</span>
                    <span className="dimension-name">{dimension.name}<small>{dimension.weight} 分</small></span>
                    <strong>{manualCalc.subtotals[dimension.id] ?? 0}<small>/{dimension.weight}</small></strong>
                  </summary>
                  <div className="criteria">
                    {dimension.criteria.map((criterion) => (
                      <div className="criterion" key={criterion.id}>
                        <div><span>{criterion.name}</span><small>{criterion.hint}</small></div>
                        <div className="score-buttons">
                          {[0, 1, 2, 3, 4, 5].map((score) => (
                            <button
                              key={score}
                              className={currentReview.scores[criterion.id] === score ? "selected" : ""}
                              onClick={() => updateReview({ scores: { ...currentReview.scores, [criterion.id]: score } })}
                            >
                              {score}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ))}

              <section className="feedback-section">
                <h3>错误标签 <small>可多选</small></h3>
                <div className="tags">
                  {errorTags.map((tag) => (
                    <button
                      key={tag}
                      className={currentReview.tags.includes(tag) ? "selected" : ""}
                      onClick={() => updateReview({
                        tags: currentReview.tags.includes(tag)
                          ? currentReview.tags.filter((item) => item !== tag)
                          : [...currentReview.tags, tag],
                      })}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <label>人工备注
                  <textarea value={currentReview.notes} onChange={(event) => updateReview({ notes: event.target.value })} rows={5} placeholder="记录具体问题、可改进点或复评结论" />
                </label>
              </section>
            </div>

            <div className="review-export">
              <button onClick={exportJson}>导出 JSON</button>
              <button className="primary" onClick={exportExcel}>导出 Excel</button>
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}
