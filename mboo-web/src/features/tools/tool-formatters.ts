import type { ToolCallStatus } from "@/lib/session-types";

const TOOL_LABELS: Record<string, string> = {
  glob_files: "查找文件",
  search_text: "搜索文本",
  read_file: "读取文件",
  edit_file: "编辑文件",
  write_file: "写入文件",
  run_command: "执行命令",
  web_search: "网络搜索",
  web_fetch: "网页抓取",
  activate_skill: "激活 Skill",
  read_skill_resource: "读取 Skill 资源",
};

export function getToolLabel(toolName: string) {
  return TOOL_LABELS[toolName] ?? toolName;
}

export function toolStatusLabel(status: ToolCallStatus) {
  if (status === "waiting_approval") return "等待授权";
  if (status === "submitting") return "处理中";
  if (status === "started") return "运行中";
  if (status === "completed") return "完成";
  return "失败";
}

export function toolStatusClassName(status: ToolCallStatus) {
  if (status === "waiting_approval" || status === "submitting" || status === "started") {
    return "bg-running-soft text-running";
  }
  if (status === "completed") return "bg-ok-soft text-ok";
  return "bg-danger-soft text-danger";
}

function hasDiffContent(text: string) {
  return text.split("\n").some((line) => line.startsWith("@@") || line.startsWith("--- "));
}

export function diffLineClassName(line: string) {
  if (line.includes("已截断，省略")) return "bg-panel-elevated text-text-3";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "bg-running-soft text-running";
  if (line.startsWith("@@")) return "bg-running-soft/60 text-running";
  if (line.startsWith("+")) return "bg-ok/10 text-ok";
  if (line.startsWith("-")) return "bg-danger-soft text-danger";
  return "text-text-2";
}

export function shouldShowDiff(toolName: string, text: string) {
  return (toolName === "edit_file" || toolName === "write_file") && hasDiffContent(text);
}
