"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Eye, FileArchive, FolderUp, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { SkillDetail, SkillImportPreview, SkillListItem, SkillSource } from "@/lib/skill-types";
import type { WorkspaceInfo } from "@/features/sessions/session-types";
import styles from "./skill-manager.module.css";

type SkillManagerProps = { workspaces: WorkspaceInfo[]; currentWorkspaceId?: string | null };
type SourceTab = "mboo" | "agents" | "builtin";

export function SkillManager({ workspaces, currentWorkspaceId }: SkillManagerProps) {
  const [sourceTab, setSourceTab] = useState<SourceTab>("mboo");
  const [items, setItems] = useState<SkillListItem[]>([]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<SkillListItem | null>(null);

  const load = useCallback(async () => {
    setError("");
    const query = new URLSearchParams({ source: sourceTab });
    if (currentWorkspaceId) query.set("workspaceId", currentWorkspaceId);
    const response = await fetch(`/api/skill/list?${query}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new Error(payload.msg || "Skill 列表加载失败");
    setItems(payload.data || []);
  }, [currentWorkspaceId, sourceTab]);

  useEffect(() => { load().catch((cause: Error) => setError(cause.message)); }, [load]);

  const openDetail = async (item: SkillListItem) => {
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ source: item.source, name: item.name });
      if (item.workspaceId) query.set("workspaceId", item.workspaceId);
      const response = await fetch(`/api/skill/detail?${query}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.msg || "Skill 详情加载失败");
      setDetail(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill 详情加载失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: SkillListItem) => {
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ source: item.source, name: item.name });
      if (item.workspaceId) query.set("workspaceId", item.workspaceId);
      const response = await fetch(`/api/skill?${query}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.msg || "Skill 删除失败");
      setConfirmDelete(null);
      await load();
      window.dispatchEvent(new Event("mboo:skills-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill 删除失败");
    } finally {
      setBusy(false);
    }
  };

  return <div className={styles.manager}>
    <div className={styles.sourceTabs} role="tablist">
      {(["mboo", "agents", "builtin"] as SourceTab[]).map((source) => <button key={source} className={sourceTab === source ? styles.sourceActive : styles.sourceTab} type="button" role="tab" aria-selected={sourceTab === source} onClick={() => { setSourceTab(source); setDetail(null); }}>{source === "mboo" ? ".mboo" : source === "agents" ? ".agents" : "内置"}</button>)}
      <span className={styles.spacer} />
      {sourceTab === "mboo" ? <button className={styles.actionButton} type="button" onClick={() => setImportOpen(true)}><Plus aria-hidden />新增</button> : null}
      <button className={styles.iconButton} type="button" aria-label="刷新 Skill" disabled={busy} onClick={() => load().catch((cause: Error) => setError(cause.message))}><RefreshCw aria-hidden /></button>
    </div>
    {items.length ? <div className={styles.list}>{groupItems(items, currentWorkspaceId).map((group) => <section className={styles.group} key={group.key}><header>{group.label}{group.current ? <span>当前工作区</span> : null}</header>{group.items.map((item) => <div className={styles.row} key={`${item.source}:${item.workspaceId || "global"}:${item.name}`}>
      <div className={styles.rowMain}><strong>{item.name}</strong><span>{item.description}</span><small>{sourceLabel(item.source)}{item.workspaceName ? ` · ${item.workspaceName}` : ""} · {formatBytes(item.totalSize)} · {item.fileCount} 个文件</small>{item.status === "INVALID" ? <em><CircleAlert aria-hidden />{item.errorMessage || "无效 Skill"}</em> : item.effective ? <b>当前生效</b> : item.shadowedBy ? <i>已被 {sourceLabel(item.shadowedBy)} 覆盖</i> : null}</div>
      <button className={styles.iconButton} type="button" aria-label={`查看 ${item.name}`} onClick={() => void openDetail(item)}><Eye aria-hidden /></button>
      {item.canDelete ? <button className={`${styles.iconButton} ${styles.danger}`} type="button" aria-label={`删除 ${item.name}`} onClick={() => setConfirmDelete(item)}><Trash2 aria-hidden /></button> : null}
    </div>)}</section>)}</div> : <div className={styles.empty}>当前来源没有 Skill</div>}
    {error ? <div className={styles.alert}>{error}</div> : null}
    {detail ? <SkillDetailDialog detail={detail} onClose={() => setDetail(null)} /> : null}
    {importOpen ? <SkillImportDialog workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} onClose={() => setImportOpen(false)} onImported={async () => { setImportOpen(false); await load(); window.dispatchEvent(new Event("mboo:skills-changed")); }} /> : null}
    {confirmDelete ? <div className={styles.inlineConfirm}><span>确认删除 {sourceLabel(confirmDelete.source)} 的 {confirmDelete.name}？</span><button disabled={busy} type="button" onClick={() => void remove(confirmDelete)}>删除</button><button type="button" onClick={() => setConfirmDelete(null)}>取消</button></div> : null}
  </div>;
}

function SkillDetailDialog({ detail, onClose }: { detail: SkillDetail; onClose: () => void }) {
  const [resourceContent, setResourceContent] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState("");
  const readResource = async (relativePath: string) => {
    const query = new URLSearchParams({ source: detail.source, name: detail.name, resource: relativePath });
    if (detail.workspaceId) query.set("workspaceId", detail.workspaceId);
    const response = await fetch(`/api/skill/detail?${query}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) { setResourceError(payload.msg || "资源读取失败"); return; }
    setResourceError("");
    setResourceContent(payload.data.resourceContent || "");
  };
  return <div className={styles.overlay}><section className={styles.detailDialog} role="dialog" aria-modal="true" aria-label={`Skill ${detail.name} 详情`}><header><div><strong>{detail.name}</strong><span>{sourceLabel(detail.source)} · {detail.contentHash.slice(0, 12)}</span></div><button className={styles.iconButton} type="button" aria-label="关闭" onClick={onClose}><X aria-hidden /></button></header><pre>{resourceContent ?? detail.skillMarkdown}</pre>{detail.resources.length ? <div className={styles.resources}><strong>资源</strong>{detail.resources.map((resource) => <button key={resource.relativePath} disabled={!resource.textReadable} type="button" onClick={() => void readResource(resource.relativePath)}>{resource.script ? "脚本 · " : ""}{resource.relativePath} · {formatBytes(resource.size)}</button>)}</div> : null}{resourceError ? <div className={styles.alert}>{resourceError}</div> : null}</section></div>;
}

function SkillImportDialog({ workspaces, currentWorkspaceId, onClose, onImported }: SkillManagerProps & { onClose: () => void; onImported: () => Promise<void> }) {
  const [target, setTarget] = useState<"PROJECT" | "GLOBAL">(currentWorkspaceId ? "PROJECT" : "GLOBAL");
  const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId || workspaces.find((item) => item.available)?.id || "");
  const [inputMode, setInputMode] = useState<"archive" | "folder" | "skillFile">("archive");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (folderRef.current) folderRef.current.setAttribute("webkitdirectory", ""); }, []);

  const buildFormData = useCallback((replaceValue?: boolean) => {
    const data = new FormData();
    data.set("target", target);
    if (replaceValue !== undefined) data.set("replace", String(replaceValue));
    if (target === "PROJECT") data.set("workspaceId", workspaceId);
    if (inputMode === "archive") data.set("archive", selectedFiles[0]);
    else if (inputMode === "skillFile") data.set("skillFile", selectedFiles[0]);
    else selectedFiles.forEach((file) => { data.append("files", file); data.append("relativePaths", file.webkitRelativePath || file.name); });
    return data;
  }, [inputMode, selectedFiles, target, workspaceId]);

  useEffect(() => {
    if (!selectedFiles.length || (target === "PROJECT" && !workspaceId)) { setPreview(null); return; }
    const controller = new AbortController();
    setPreviewBusy(true); setPreview(null); setError("");
    fetch("/api/skill/import/preview", { method: "POST", body: buildFormData(), signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success === false) throw new Error(payload.msg || "Skill 解析失败");
        setPreview(payload.data);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Skill 解析失败"); })
      .finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [buildFormData, selectedFiles.length, target, workspaceId]);

  const submit = async () => {
    if (!selectedFiles.length) { setError("请选择要导入的文件"); return; }
    if (target === "PROJECT" && !workspaceId) { setError("请选择可用工作区"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/skill/import", { method: "POST", body: buildFormData(replace) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.msg || "Skill 导入失败");
      await onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill 导入失败");
    } finally {
      setBusy(false);
    }
  };

  const choose = (mode: typeof inputMode, files: FileList | null) => {
    setInputMode(mode); setSelectedFiles(Array.from(files || [])); setPreview(null); setError("");
  };
  const replaceRequired = Boolean(preview?.conflict && !replace);

  return <div className={styles.overlay}><section className={styles.importDialog} role="dialog" aria-modal="true" aria-label="导入 Skill"><header><strong>导入 Skill</strong><button className={styles.iconButton} type="button" aria-label="关闭" onClick={onClose}><X aria-hidden /></button></header><label>目标<select value={target} onChange={(event) => setTarget(event.target.value as "PROJECT" | "GLOBAL")}><option value="PROJECT">项目</option><option value="GLOBAL">全局</option></select></label>{target === "PROJECT" ? <label>工作区<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} disabled={!workspace.available} value={workspace.id}>{workspace.name}{workspace.available ? "" : "（不可用）"}</option>)}</select></label> : null}<div className={styles.uploadModes}><label><FileArchive aria-hidden />ZIP<input type="file" accept=".zip" onChange={(event) => choose("archive", event.target.files)} /></label><label><FolderUp aria-hidden />文件夹<input ref={folderRef} type="file" multiple onChange={(event) => choose("folder", event.target.files)} /></label><label><Plus aria-hidden />Markdown<input type="file" accept=".md,text/markdown" onChange={(event) => choose("skillFile", event.target.files)} /></label></div><div className={styles.fileSummary}>{selectedFiles.length ? `${selectedFiles.length} 个上传文件 · ${formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0))}` : "尚未选择文件"}</div>{previewBusy ? <div className={styles.preview}>正在安全解析 Skill…</div> : preview ? <dl className={styles.preview}><div><dt>名称</dt><dd>{preview.name}</dd></div><div><dt>描述</dt><dd>{preview.description}</dd></div><div><dt>目标</dt><dd>{preview.targetDisplayPath}</dd></div><div><dt>SKILL.md</dt><dd>{formatBytes(preview.contentSize)}</dd></div><div><dt>解压后</dt><dd>{formatBytes(preview.totalSize)} · {preview.fileCount} 个文件 · {preview.resourceCount} 个资源</dd></div><div><dt>hash</dt><dd>{preview.contentHash.slice(0, 12)}</dd></div>{preview.conflict ? <div className={styles.previewConflict}><dt>冲突</dt><dd>目标来源已存在同名 Skill</dd></div> : null}</dl> : null}<label className={styles.checkbox}><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />明确替换目标来源中的同名 .mboo Skill</label>{error ? <div className={styles.alert}>{error}</div> : null}<footer><button type="button" onClick={onClose}>取消</button><button disabled={busy || previewBusy || !preview || replaceRequired} type="button" onClick={() => void submit()}>{busy ? "安装中…" : replaceRequired ? "请确认替换" : "安装"}</button></footer></section></div>;
}

function sourceLabel(source: SkillSource) { return ({ PROJECT_MBOO: "项目 .mboo", PROJECT_AGENTS: "项目 .agents", GLOBAL_MBOO: "全局 .mboo", GLOBAL_AGENTS: "全局 .agents", BUILTIN: "内置" } satisfies Record<SkillSource, string>)[source]; }
function formatBytes(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`; }
function groupItems(items: SkillListItem[], currentWorkspaceId?: string | null) {
  const groups = new Map<string, { key: string; label: string; current: boolean; items: SkillListItem[] }>();
  for (const item of items) {
    const key = item.scope === "PROJECT" ? `project:${item.workspaceId}` : item.scope.toLowerCase();
    const label = item.scope === "PROJECT" ? item.workspaceName || "项目 Skill" : item.scope === "GLOBAL" ? "全局" : "应用内置";
    const group = groups.get(key) || { key, label, current: Boolean(item.workspaceId && item.workspaceId === currentWorkspaceId), items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return Array.from(groups.values()).sort((left, right) => Number(right.current) - Number(left.current) || left.label.localeCompare(right.label, "zh-CN"));
}
