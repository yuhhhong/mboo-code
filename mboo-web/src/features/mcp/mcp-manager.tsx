"use client";

import { CircleAlert, Code2, Plug, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./mcp-manager.module.css";
import { SkillManager } from "@/features/skill/skill-manager";
import type { WorkspaceInfo } from "@/features/sessions/session-types";

type McpServer = {
  id: string;
  name: string;
  configJson: string;
  enabled: boolean;
  runtimeStatus: string;
  lastError: string | null;
  toolCount: number;
};

const EMPTY_JSON = '{\n  "mcpServers": {}\n}';

export function McpManager({ workspaces = [], currentWorkspaceId }: { workspaces?: WorkspaceInfo[]; currentWorkspaceId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mcp" | "skill">("mcp");
  const [servers, setServers] = useState<McpServer[]>([]);
  const [json, setJson] = useState(EMPTY_JSON);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/mcp/list", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new Error(payload.msg || "MCP 列表加载失败");
    setServers(payload.data || []);
  }, []);

  useEffect(() => {
    if (!open) return;
    load().catch((cause: Error) => setError(cause.message));
    const timer = window.setInterval(() => load().catch((cause: Error) => setError(cause.message)), 2500);
    return () => window.clearInterval(timer);
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const request = async (path: string, init: RequestInit) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.msg || "操作失败");
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const success = await request(editingId ? `/api/mcp/${encodeURIComponent(editingId)}` : "/api/mcp", { method: editingId ? "PUT" : "POST", body: json });
    if (success) resetEditor();
  };
  const edit = (server: McpServer) => { setEditingId(server.id); setJson(server.configJson); setError(""); };
  const resetEditor = () => { setEditingId(null); setJson(EMPTY_JSON); };

  return (
    <>
      <button className={styles.entry} type="button" aria-label="管理插件" onClick={() => setOpen(true)}>
        <Plug aria-hidden className={styles.entryIcon} />
        <span>插件</span>
      </button>
      {open && typeof document !== "undefined" ? createPortal((
        <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="插件管理">
            <header className={styles.header}><h2>插件管理</h2><button className={styles.iconButton} type="button" aria-label="关闭" title="关闭" onClick={() => setOpen(false)}><X aria-hidden /></button></header>
            <div className={styles.tabs} role="tablist"><button className={tab === "mcp" ? styles.tabActive : styles.tab} type="button" role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")}>MCP</button><button className={tab === "skill" ? styles.tabActive : styles.tab} type="button" role="tab" aria-selected={tab === "skill"} onClick={() => setTab("skill")}>SKILL</button></div>
            {tab === "mcp" ? <div className={styles.content}>
              <div className={styles.toolbar}><strong>MCP 服务器</strong><button className={styles.secondaryButton} type="button" onClick={() => { resetEditor(); setError(""); }}><Plus aria-hidden />新增</button><button className={styles.iconButton} type="button" aria-label="刷新" title="刷新" disabled={busy} onClick={() => load().catch((cause: Error) => setError(cause.message))}><RefreshCw aria-hidden /></button></div>
              {servers.length === 0 ? <div className={styles.empty}>暂无 MCP 服务器</div> : <div className={styles.list}>{servers.map((server) => <div className={styles.row} key={server.id}>
                <div className={styles.rowMain}><strong>{server.name}</strong><span className={styles.meta}>{server.runtimeStatus} · {server.toolCount} 个工具</span>{server.lastError ? <span className={styles.errorText}><CircleAlert aria-hidden />{server.lastError}</span> : null}</div>
                <label className={styles.switch}><input type="checkbox" checked={server.enabled} disabled={busy} onChange={(event) => request(`/api/mcp/${encodeURIComponent(server.id)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: event.target.checked }) })} /><span /></label>
                <button className={styles.iconButton} type="button" aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => edit(server)}><Code2 aria-hidden /></button><button className={styles.iconButton} type="button" aria-label={`重连 ${server.name}`} title="重连" disabled={busy} onClick={() => request(`/api/mcp/${encodeURIComponent(server.id)}/reconnect`, { method: "POST" })}><RefreshCw aria-hidden /></button><button className={`${styles.iconButton} ${styles.danger}`} type="button" aria-label={`删除 ${server.name}`} title="删除" onClick={() => setConfirmId(server.id)}><Trash2 aria-hidden /></button>
                {confirmId === server.id ? <div className={styles.confirm}><span>确认删除 {server.name}？</span><button type="button" onClick={() => { setConfirmId(null); request(`/api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" }); }}>删除</button><button type="button" onClick={() => setConfirmId(null)}>取消</button></div> : null}
              </div>)}</div>}
              <div className={styles.editor}><div className={styles.editorTitle}><strong>{editingId ? "编辑配置" : "新增配置"}</strong>{editingId ? <button className={styles.textButton} type="button" onClick={resetEditor}>新建</button> : null}</div><textarea value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} aria-label="MCP 配置 JSON" /><button className={styles.saveButton} type="button" disabled={busy} onClick={submit}><Save aria-hidden />保存配置</button></div>
              {error ? <div className={styles.alert}>{error}</div> : null}
            </div> : <SkillManager workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} />}
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
