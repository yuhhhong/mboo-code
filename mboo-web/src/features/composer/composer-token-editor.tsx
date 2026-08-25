"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SkillSuggestion } from "@/lib/skill-types";
import styles from "./composer-token-editor.module.css";

const SKILL_TAG_PATTERN = /<skill>([a-z0-9]+(?:-[a-z0-9]+)*)<\/skill>/g;
const TRIGGER_PATTERN = /(?:^|\s)\/([a-z0-9-]*)$/;

type ComposerTokenEditorProps = {
  id: string;
  value: string;
  disabled: boolean;
  workspaceId?: string | null;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

export function ComposerTokenEditor({ id, value, disabled, workspaceId, placeholder, onChange, onSubmit }: ComposerTokenEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [knownSkillNames, setKnownSkillNames] = useState<Set<string>>(new Set());
  const parsed = useMemo(() => parseSerializedValue(value, knownSkillNames), [knownSkillNames, value]);

  const closeSuggestions = useCallback(() => { setSuggestionOpen(false); setSuggestions([]); setActiveIndex(0); }, []);

  const refreshKnownSkills = useCallback((signal?: AbortSignal) => {
    const query = new URLSearchParams({ q: "" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    return fetch(`/api/skill/suggest?${query}`, { cache: "no-store", signal })
      .then((response) => response.json())
      .then((payload) => { if (payload.success !== false) setKnownSkillNames(new Set(((payload.data || []) as SkillSuggestion[]).map((item) => item.name))); })
      .catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshKnownSkills(controller.signal);
    const handleSkillsChanged = () => { void refreshKnownSkills(); };
    window.addEventListener("mboo:skills-changed", handleSkillsChanged);
    return () => { controller.abort(); window.removeEventListener("mboo:skills-changed", handleSkillsChanged); };
  }, [refreshKnownSkills]);

  const search = useCallback(async (text: string, selectionStart: number) => {
    const beforeCursor = text.slice(0, selectionStart);
    const match = TRIGGER_PATTERN.exec(beforeCursor);
    if (!match) { closeSuggestions(); return; }
    const query = new URLSearchParams({ q: match[1] || "" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    const response = await fetch(`/api/skill/suggest?${query}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) { closeSuggestions(); return; }
    const next = (payload.data || []) as SkillSuggestion[];
    setKnownSkillNames((current) => new Set([...current, ...next.map((item) => item.name)]));
    setSuggestions(next);
    setSuggestionOpen(next.length > 0);
    setActiveIndex(0);
  }, [closeSuggestions, workspaceId]);

  useEffect(() => { if (disabled) closeSuggestions(); }, [closeSuggestions, disabled]);

  const updateText = (text: string, selectionStart: number) => {
    onChange(serialize(parsed.skillNames, text));
    void search(text, selectionStart);
  };

  const selectSuggestion = (suggestion: SkillSuggestion) => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? parsed.text.length;
    const beforeCursor = parsed.text.slice(0, cursor);
    const match = TRIGGER_PATTERN.exec(beforeCursor);
    if (!match) return;
    const slashIndex = beforeCursor.lastIndexOf("/");
    const nextText = parsed.text.slice(0, slashIndex) + parsed.text.slice(cursor);
    const nextNames = parsed.skillNames.includes(suggestion.name) ? parsed.skillNames : [...parsed.skillNames, suggestion.name];
    onChange(serialize(nextNames, nextText));
    closeSuggestions();
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(slashIndex, slashIndex);
    });
  };

  const removeToken = (name: string) => {
    onChange(serialize(parsed.skillNames.filter((item) => item !== name), parsed.text));
    textareaRef.current?.focus();
  };

  return <div className={styles.editor}>
    {parsed.skillNames.length ? <div className={styles.tokens} aria-label="已选择 Skill">{parsed.skillNames.map((name) => <span className={styles.token} key={name}>/{name}<button type="button" aria-label={`移除 ${name}`} disabled={disabled} onClick={() => removeToken(name)}><X aria-hidden /></button></span>)}</div> : null}
    <textarea
      ref={textareaRef}
      className={styles.textarea}
      id={id}
      disabled={disabled}
      placeholder={placeholder}
      value={parsed.text}
      onBlur={() => window.setTimeout(closeSuggestions, 120)}
      onChange={(event) => updateText(event.target.value, event.target.selectionStart)}
      onClick={(event) => void search(event.currentTarget.value, event.currentTarget.selectionStart)}
      onKeyDown={(event) => {
        if (suggestionOpen && suggestions.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); closeSuggestions(); return; }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); selectSuggestion(suggestions[activeIndex]); return;
          }
        }
        if (event.key === "Backspace" && !parsed.text && parsed.skillNames.length) { event.preventDefault(); removeToken(parsed.skillNames.at(-1)!); return; }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); }
      }}
    />
    {suggestionOpen ? <div className={styles.menu} role="listbox" aria-label="Skill 联想">{suggestions.map((suggestion, index) => <button key={suggestion.name} className={index === activeIndex ? styles.optionActive : styles.option} type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => { event.preventDefault(); selectSuggestion(suggestion); }}><strong>/{suggestion.name}</strong><span>{suggestion.description}</span><small>{sourceLabel(suggestion.source)}</small></button>)}</div> : null}
  </div>;
}

function parseSerializedValue(value: string, knownSkillNames: Set<string>) {
  const skillNames: string[] = [];
  const seen = new Set<string>();
  const text = value.replace(SKILL_TAG_PATTERN, (_tag, name: string) => {
    if (!knownSkillNames.has(name)) return _tag;
    if (!seen.has(name)) { seen.add(name); skillNames.push(name); }
    return "";
  });
  return { skillNames, text };
}

function serialize(skillNames: string[], text: string) { return `${skillNames.map((name) => `<skill>${name}</skill>`).join("")}${text}`; }
function sourceLabel(source: SkillSuggestion["source"]) { return source === "BUILTIN" ? "内置" : source.startsWith("PROJECT") ? "项目" : "全局"; }
