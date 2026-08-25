package com.yu.mboocode.agent.dto;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "MCP 服务器响应")
public record McpServerResp(
        @Schema(description = "服务器 ID") String id,
        @Schema(description = "服务器名称") String name,
        @Schema(description = "带 mcpServers 外层的配置 JSON") String configJson,
        @Schema(description = "是否启用") boolean enabled,
        @Schema(description = "运行状态") String runtimeStatus,
        @Schema(description = "最近一次脱敏错误") String lastError,
        @Schema(description = "已发现工具数量") int toolCount,
        @Schema(description = "创建时间") String createdAt,
        @Schema(description = "更新时间") String updatedAt) {
}
