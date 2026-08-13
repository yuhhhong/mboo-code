"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import MarkdownRender, {
  TableNode as MarkstreamTableNode,
  defineStreamingComponents,
  type NodeComponentProps,
} from "markstream-react";
import type {
  CodeBlockNode,
  InlineCodeNode,
  LinkNode,
  ParsedNode,
  TableCellNode,
  TableNode as MarkdownTableNode,
  TableRowNode,
} from "stream-markdown-parser";

type AssistantMarkdownProps = {
  content: string;
  messageId: string;
  isStreaming?: boolean;
};

type CopyState = "idle" | "copied" | "failed";

type MarkdownActionApi = {
  announce: (message: string) => void;
  runCopy: (text: string, successText?: string) => Promise<CopyState>;
};

// placeholder to satisfy TS before real provider; real values come from AssistantMarkdown
const MarkdownActionContext = createContext<MarkdownActionApi>({
  announce: () => undefined,
  runCopy: async () => "failed",
});

async function copyText(text: string) {
  const value = text.replace(/\s+$/u, "");
  if (!value) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function nodeText(node: ParsedNode | undefined): string {
  if (!node) {
    return "";
  }
  const record = node as ParsedNode & {
    text?: string;
    code?: string;
    content?: string;
    children?: ParsedNode[];
    cells?: TableCellNode[];
  };
  if (typeof record.text === "string" && record.text) {
    return record.text;
  }
  if (typeof record.code === "string" && record.code) {
    return record.code;
  }
  if (typeof record.content === "string" && record.content && !record.children?.length) {
    return record.content;
  }
  if (Array.isArray(record.cells)) {
    return record.cells.map((cell) => nodeText(cell as unknown as ParsedNode)).join("\t");
  }
  if (Array.isArray(record.children)) {
    return record.children.map((child) => nodeText(child)).join("");
  }
  return "";
}

function tableToTsv(table: MarkdownTableNode) {
  const rows: TableRowNode[] = [];
  if (table.header) {
    rows.push(table.header);
  }
  if (Array.isArray(table.rows)) {
    rows.push(...table.rows);
  }
  return rows
    .map((row) => (row.cells || []).map((cell) => nodeText(cell as unknown as ParsedNode).replace(/\t|\n/g, " ")).join("\t"))
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function useLocalCopyState() {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timer = window.setTimeout(() => setCopyState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  return { copyState, setCopyState };
}

function CopyButton({
  label = "复制",
  text,
  successText = "已复制到剪贴板",
}: {
  label?: string;
  text: string;
  successText?: string;
}) {
  const { runCopy } = useContext(MarkdownActionContext);
  const { copyState, setCopyState } = useLocalCopyState();

  return (
    <button
      type="button"
      className="mboo-md-copy"
      onClick={() => {
        void runCopy(text, successText).then(setCopyState);
      }}
      aria-label={label}
    >
      {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : label}
    </button>
  );
}

function MbooCodeBlock({ node }: NodeComponentProps<CodeBlockNode>) {
  const reactId = useId();
  const panelId = `${reactId}-code`;
  const language = (node.language || "").trim();
  const code = node.code || "";
  const lineCount = code ? code.split("\n").length : 0;
  const collapsible = lineCount > 24;
  const [expanded, setExpanded] = useState(!collapsible || Boolean(node.loading));

  useEffect(() => {
    if (!collapsible || node.loading) {
      setExpanded(true);
    }
  }, [collapsible, node.loading, code.length]);

  const toggleLabel = expanded ? "收起代码" : `展开全部 ${lineCount} 行`;

  return (
    <figure className="mboo-md-codeblock">
      <figcaption className="mboo-md-codeblock__bar">
        <span className="mboo-md-codeblock__lang">{language || "code"}</span>
        <div className="mboo-md-codeblock__actions">
          {collapsible ? (
            <button
              type="button"
              className="mboo-md-toggle"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setExpanded((current) => !current)}
            >
              {toggleLabel}
            </button>
          ) : null}
          <CopyButton label="复制代码" text={code} successText="代码已复制" />
        </div>
      </figcaption>
      <pre id={panelId} className={expanded ? undefined : "is-collapsed"} tabIndex={0}>
        <code>{code}</code>
      </pre>
      {collapsible && !expanded ? (
        <div className="mboo-md-codeblock__more">
          <button
            type="button"
            className="mboo-md-toggle"
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => setExpanded(true)}
          >
            显示全部 {lineCount} 行
          </button>
        </div>
      ) : null}
    </figure>
  );
}

function MbooInlineCode({ node }: NodeComponentProps<InlineCodeNode>) {
  const code = node.code || "";
  // 设计决策：行内 code 保持可选中文本；复制只走显式小按钮
  return (
    <span className="mboo-md-inline-code">
      <code>{code}</code>
      <CopyButton label="复制" text={code} successText="代码已复制" />
    </span>
  );
}

function MbooLink({
  node,
  renderNode,
  children,
  ctx,
}: NodeComponentProps<LinkNode>) {
  const href = node.href || "";
  const isExternal = /^https?:\/\//i.test(href);
  const childNodes =
    node.children?.length && renderNode && ctx
      ? node.children.map((child, index) => renderNode(child, `${child.type}_${index}`, ctx))
      : children || node.text || href;

  return (
    <a
      href={href || undefined}
      className={isExternal ? "mboo-md-link is-external" : "mboo-md-link"}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      title={node.title || (isExternal ? "在新标签打开外链" : undefined)}
    >
      {childNodes}
      {isExternal ? (
        <span className="mboo-md-link__mark" aria-hidden>
          ↗
        </span>
      ) : null}
    </a>
  );
}

function MbooTable(props: NodeComponentProps<MarkdownTableNode>) {
  const tsv = useMemo(() => tableToTsv(props.node), [props.node]);

  return (
    <div className="mboo-md-table">
      <div className="mboo-md-table__bar">
        <span className="mboo-md-table__label">表格</span>
        <CopyButton label="复制表格" text={tsv} successText="表格已复制为 TSV" />
      </div>
      <div className="mboo-md-table-scroll" role="region" aria-label="表格内容" tabIndex={0}>
        <MarkstreamTableNode {...props} />
      </div>
    </div>
  );
}

const streamingComponents = defineStreamingComponents({
  code_block: MbooCodeBlock,
  inline_code: MbooInlineCode,
  link: MbooLink,
  table: MbooTable,
});

function MarkdownActionProvider({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState("");

  const announce = useCallback((message: string) => {
    // 先清空再写入，确保连续相同文案也会被读屏重新播报
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 20);
  }, []);

  const runCopy = useCallback(
    async (text: string, successText = "已复制到剪贴板") => {
      const ok = await copyText(text);
      if (ok) {
        announce(successText);
        return "copied" as const;
      }
      announce("复制失败，请检查剪贴板权限后重试");
      return "failed" as const;
    },
    [announce],
  );

  const api = useMemo(() => ({ announce, runCopy }), [announce, runCopy]);

  return (
    <MarkdownActionContext.Provider value={api}>
      {children}
      <div className="mboo-md-live" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </MarkdownActionContext.Provider>
  );
}

/**
 * 设计决策：助手正文是 QQ2007 任务文档流。
 * 复制只走显式按钮 + 统一 live region；折叠有完整 ARIA；不做静默点 pre 复制。
 */
const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  messageId,
  isStreaming = false,
}: AssistantMarkdownProps) {
  const customId = useMemo(() => `mboo-chat-${messageId}`, [messageId]);

  if (!content) {
    return isStreaming ? (
      <span className="text-text-3" role="status">
        生成中…
      </span>
    ) : null;
  }

  return (
    <MarkdownActionProvider>
      <div
        className="mboo-markdown min-w-0"
        data-streaming={isStreaming ? "true" : "false"}
        data-message-id={messageId}
      >
        <MarkdownRender
          content={content}
          customId={customId}
          final={!isStreaming}
          typewriter={isStreaming}
          fade={false}
          smoothStreaming={isStreaming ? "auto" : false}
          maxLiveNodes={isStreaming ? 0 : undefined}
          renderCodeBlocksAsPre
          isDark={false}
          streamingComponents={streamingComponents}
        />
        {isStreaming ? (
          <span className="sr-only" role="status">
            正在生成回复
          </span>
        ) : null}
      </div>
    </MarkdownActionProvider>
  );
});

export default AssistantMarkdown;
