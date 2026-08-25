package com.yu.mboocode.llm.context;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

@Schema(description = "版本化的上下文保留工具结果集合")
public record RetainedToolResults(int version, List<RetainedToolResult> entries) {
    public RetainedToolResults {
        version = version <= 0 ? 1 : version;
        entries = entries == null ? List.of() : List.copyOf(entries);
    }

    public static RetainedToolResults empty() {
        return new RetainedToolResults(1, List.of());
    }
}
