"use client";

import { X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { AskDraftProgress, ToolCallView } from "@/features/agent-run/message-model";

const SKIPPED_ANSWER = "用户跳过此问题";

export const AskCard = memo(function AskCard({ toolCall, sessionId, isCancelling, onCancel, onProgress }: { toolCall: ToolCallView; sessionId: string; isCancelling: boolean; onCancel: () => void; onProgress: (toolCallId: string, progress: AskDraftProgress) => void }) {
  const questions = toolCall.askQuestions ?? [];
  const [page, setPage] = useState(() => toolCall.askDraftPage ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<string[]>(() =>
    Array.from({ length: questions.length }, (_, index) => toolCall.askAnswers?.[index] ?? toolCall.askDraftAnswers?.[index] ?? ""),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    const nextAnswers = toolCall.askAnswers ?? toolCall.askDraftAnswers;
    if (nextAnswers) setAnswers(Array.from({ length: questions.length }, (_, index) => nextAnswers[index] ?? ""));
  }, [questions.length, toolCall.askAnswers, toolCall.askDraftAnswers]);
  useEffect(() => { if (typeof toolCall.askDraftPage === "number") setPage(toolCall.askDraftPage); }, [toolCall.askDraftPage]);
  const current = questions[page];
  const currentAnswer = answers[page] ?? "";
  const selectedOption = current?.answers.some((option) => option.text === currentAnswer) ?? false;
  const skipped = currentAnswer === SKIPPED_ANSWER;
  const hasCustomAnswer = Boolean(currentAnswer && !selectedOption && !skipped);
  useEffect(() => {
    const answer = answers[page] ?? "";
    const pageQuestion = toolCall.askQuestions?.[page];
    const isOptionAnswer = pageQuestion?.answers.some((option) => option.text === answer) ?? false;
    setCustom(answer && !isOptionAnswer && answer !== SKIPPED_ANSWER ? answer : "");
  }, [answers, page, toolCall.askQuestions]);
  const isDone = toolCall.status === "completed" || toolCall.status === "failed";
  const submit = async (action: "ANSWER" | "SKIP", text?: string) => {
    if (!current || submitting || isCancelling || isDone) return;
    const value = action === "SKIP" ? undefined : text?.trim();
    if (action === "ANSWER" && !value) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(toolCall.id)}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageIndex: page, action, text: value, actionId: crypto.randomUUID() }) });
      if (!response.ok) throw new Error("提交问题答案失败");
      const next = Array.from({ length: questions.length }, (_, index) => index === page ? (action === "SKIP" ? SKIPPED_ANSWER : value!) : (answers[index] ?? ""));
      setAnswers(next); setCustom("");
      const nextPage = next.findIndex((item) => !item.trim());
      const targetPage = nextPage >= 0 ? nextPage : questions.length - 1;
      setPage(targetPage);
      onProgress(toolCall.id, { answers: next, pageIndex: targetPage });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交问题答案失败");
    } finally {
      setSubmitting(false);
    }
  };
  if (!current && !isDone) return null;
  if (isDone) return <div className="rounded-2xl bg-panel-muted p-3 text-sm"><p className="font-medium">{toolCall.status === "failed" ? (toolCall.errorMessage || "提问请求已失效") : "已完成提问"}</p>{answers.length ? <ol className="mt-2 list-decimal space-y-2 pl-5">{answers.map((answer, index) => <li key={index}>{questions[index]?.question ? <p className="whitespace-pre-wrap font-semibold text-text-1">{questions[index].question}</p> : null}<p className="mt-0.5 whitespace-pre-wrap text-text-2">回答：{answer}</p></li>)}</ol> : null}</div>;
  return <section className="rounded-2xl bg-panel-muted p-3" aria-label="提问" aria-busy={isCancelling}>
    <header className="mb-2 flex items-start justify-between gap-3"><div><p className="text-[11px] text-text-3">问题 {page + 1}/{questions.length}</p><h3 className="mt-0.5 whitespace-pre-wrap text-sm font-semibold text-text-1">{current.question}</h3></div><div className="flex items-center gap-1"><button type="button" disabled={page === 0 || submitting || isCancelling} onClick={() => { const targetPage = Math.max(0, page - 1); setPage(targetPage); onProgress(toolCall.id, { answers, pageIndex: targetPage }); }} className="inline-flex h-7 items-center rounded-md border border-transparent px-2 text-[11px] text-text-3 transition-colors hover:border-line hover:bg-panel-muted hover:text-text-1 disabled:opacity-40">上一页</button><button type="button" disabled={isCancelling} aria-label="关闭提问并取消当前任务" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-text-3 transition-colors hover:border-line hover:bg-panel-muted hover:text-text-1 disabled:opacity-40"><X className="size-3.5" aria-hidden /></button></div></header>
    <div className="space-y-1.5">{current.answers.map((option, index) => { const selected = option.text === currentAnswer; return <button key={`${option.text}-${index}`} type="button" aria-pressed={selected} disabled={submitting || isCancelling} onClick={() => void submit("ANSWER", option.text)} className={`w-full rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-50 shadow-[0_0.56px_0.56px_0_rgba(0,0,0,0.06)] ${selected ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-accent/50"}`}><span className="flex items-center gap-2 text-sm font-medium">{option.text}{index === 0 ? <span className="text-[11px] text-accent">推荐</span> : null}{selected ? <span className="text-[11px] text-accent">已选择</span> : null}</span>{option.description ? <span className="mt-0.5 block whitespace-pre-wrap text-xs leading-5 text-text-3">{option.description}</span> : null}</button>; })}</div>
    {error ? <p className="mt-2 text-xs text-danger" role="alert">{error}</p> : null}<div className="mt-2 flex items-end gap-2"><textarea value={custom} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit("ANSWER", custom); } }} disabled={submitting || isCancelling} maxLength={2000} rows={2} placeholder="或者输入自定义答案" className={`min-h-9 flex-1 resize-y rounded-md border px-3 py-2 text-sm outline-none transition-shadow placeholder:text-text-4 focus:ring-2 focus:ring-accent/30 ${hasCustomAnswer ? "border-accent bg-accent-soft" : "border-line bg-panel"}`} aria-label={hasCustomAnswer ? "自定义答案，当前已选择" : "自定义答案"} /><button type="button" aria-pressed={skipped} disabled={submitting || isCancelling} onClick={() => void submit("SKIP")} className={`inline-flex h-9 shrink-0 items-center rounded-md px-2.5 text-xs transition-colors disabled:opacity-50 ${skipped ? "text-accent font-medium" : "text-text-3 hover:bg-panel hover:text-text-1"}`}>{skipped ? "已跳过" : "跳过"}</button></div>
  </section>;
});
