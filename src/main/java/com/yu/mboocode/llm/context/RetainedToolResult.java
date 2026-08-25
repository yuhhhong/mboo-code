package com.yu.mboocode.llm.context;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.Map;

@Schema(description = "跨摘要边界原样保留的工具结果")
public record RetainedToolResult(
        String toolName,
        String retentionKey,
        Map<String, Object> arguments,
        String resultText,
        Map<String, Object> attributes,
        String skillSource,
        String contentHash,
        String createdAt
) {
    public RetainedToolResult {
        arguments = arguments == null ? Map.of() : Map.copyOf(arguments);
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }
}
