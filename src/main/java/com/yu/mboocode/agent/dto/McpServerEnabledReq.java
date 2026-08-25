package com.yu.mboocode.agent.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;

@Schema(description = "MCP 启用状态请求")
public record McpServerEnabledReq(@NotNull @Schema(description = "是否启用") Boolean enabled) {
}
