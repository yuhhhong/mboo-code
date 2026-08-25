package com.yu.mboocode.llm.context;

/**
 * 完整工具请求/结果对的上下文策略。未来可读取结果状态实现 task_list 等条件策略。
 */
public interface ToolMemoryPolicy {
    boolean shouldThin(ToolCallGroup toolGroup);

    boolean shouldSummarize(ToolCallGroup toolGroup);

    String retentionKey(ToolCallGroup toolGroup);
}
