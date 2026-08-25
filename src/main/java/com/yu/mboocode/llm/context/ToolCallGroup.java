package com.yu.mboocode.llm.context;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.ToolExecutionResultMessage;

/** 已完成协议配对的单次工具请求和结果。 */
public record ToolCallGroup(ToolExecutionRequest request, ToolExecutionResultMessage result) {
}
