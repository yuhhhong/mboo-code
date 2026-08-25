package com.yu.mboocode.agent.controller;

import com.yu.mboocode.agent.dto.McpServerEnabledReq;
import com.yu.mboocode.agent.dto.McpServerResp;
import com.yu.mboocode.agent.service.McpServerService;
import com.yu.mboocode.common.dto.R;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.annotation.Resource;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@Tag(name = "MCP 插件")
@RestController
@RequestMapping("/mcp")
public class McpServerController {
    @Resource
    private McpServerService mcpServerService;

    @Operation(summary = "MCP 服务器列表")
    @GetMapping("/list")
    public R<List<McpServerResp>> list() {
        return R.ok(mcpServerService.listResponses());
    }

    @Operation(summary = "批量新增 MCP 服务器")
    @PostMapping
    public R<List<McpServerResp>> create(@RequestBody String configJson) {
        return R.ok(mcpServerService.create(configJson));
    }

    @Operation(summary = "编辑 MCP 服务器")
    @PutMapping("/{mcpId}")
    public R<McpServerResp> update(@PathVariable String mcpId, @RequestBody String configJson) {
        return R.ok(mcpServerService.update(mcpId, configJson));
    }

    @Operation(summary = "启用或停用 MCP 服务器")
    @PatchMapping("/{mcpId}/enabled")
    public R<McpServerResp> updateEnabled(@PathVariable String mcpId, @Valid @RequestBody McpServerEnabledReq req) {
        return R.ok(mcpServerService.updateEnabled(mcpId, req.enabled()));
    }

    @Operation(summary = "重连 MCP 服务器")
    @PostMapping("/{mcpId}/reconnect")
    public R<McpServerResp> reconnect(@PathVariable String mcpId) {
        return R.ok(mcpServerService.reconnect(mcpId));
    }

    @Operation(summary = "删除 MCP 服务器")
    @DeleteMapping("/{mcpId}")
    public R<Void> delete(@PathVariable String mcpId) {
        mcpServerService.delete(mcpId);
        return R.ok();
    }
}
