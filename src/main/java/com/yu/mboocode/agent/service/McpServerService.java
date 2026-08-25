package com.yu.mboocode.agent.service;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.yu.mboocode.agent.dto.McpServerResp;
import com.yu.mboocode.agent.mapper.McpServerMapper;
import com.yu.mboocode.agent.model.McpServer;
import com.yu.mboocode.common.exception.ServiceException;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
@Slf4j
public class McpServerService extends ServiceImpl<McpServerMapper, McpServer> {
    public static final int MAX_CONFIG_BYTES = 64 * 1024;
    public static final int MAX_SERVERS = 50;
    public static final int MAX_TOOLS = 128;
    private static final Set<String> ALLOWED_FIELDS = Set.of("command", "args", "env", "cwd", "type", "url", "headers");
    private static final Set<String> STDIO_FIELDS = Set.of("command", "args", "env", "cwd");
    private static final Set<String> HTTP_FIELDS = Set.of("type", "url", "headers");

    @Resource
    private McpServerRuntime runtime;

    @PostConstruct
    public void loadRuntimeStates() {
        list().forEach(runtime::refresh);
    }

    public List<McpServerResp> listResponses() {
        return list(Wrappers.<McpServer>query().orderByAsc("created_at").orderByAsc("id")).stream().map(this::toResponse).toList();
    }

    @Transactional
    public List<McpServerResp> create(String rawJson) {
        List<ParsedServer> parsed = parseBatch(rawJson);
        if (count() + parsed.size() > MAX_SERVERS) throw new ServiceException("MCP 服务器最多保存 " + MAX_SERVERS + " 个");
        Set<String> names = new HashSet<>();
        for (ParsedServer item : parsed) {
            if (!names.add(item.name.toLowerCase(Locale.ROOT)) || getByName(item.name) != null) throw new ServiceException("MCP 服务器名称已存在: " + item.name);
        }
        List<McpServer> records = parsed.stream().map(item -> {
            McpServer server = new McpServer();
            server.setName(item.name);
            server.setMcpJson(item.config.toJSONString());
            server.setEnabled(true);
            return server;
        }).toList();
        try {
            saveBatch(records);
        } catch (DataIntegrityViolationException e) {
            throw new ServiceException("MCP 服务器名称已存在");
        }
        records.forEach(runtime::refresh);
        return records.stream().map(this::toResponse).toList();
    }

    @Transactional
    public McpServerResp update(String id, String rawJson) {
        McpServer server = require(id);
        List<ParsedServer> parsed = parseBatch(rawJson);
        if (parsed.size() != 1) throw new ServiceException("编辑时只能提交一个 MCP 服务器");
        ParsedServer item = parsed.getFirst();
        McpServer conflict = getByName(item.name);
        if (conflict != null && !id.equals(conflict.getId())) throw new ServiceException("MCP 服务器名称已存在: " + item.name);
        server.setName(item.name);
        server.setMcpJson(item.config.toJSONString());
        try {
            updateById(server);
        } catch (DataIntegrityViolationException e) {
            throw new ServiceException("MCP 服务器名称已存在");
        }
        runtime.refresh(server);
        return toResponse(server);
    }

    @Transactional
    public McpServerResp updateEnabled(String id, boolean enabled) {
        McpServer server = require(id);
        server.setEnabled(enabled);
        updateById(server);
        runtime.refresh(server);
        return toResponse(server);
    }

    public McpServerResp reconnect(String id) {
        McpServer server = require(id);
        runtime.refresh(server);
        return toResponse(server);
    }

    @Transactional
    public void delete(String id) {
        require(id);
        removeById(id);
        runtime.remove(id);
    }

    private McpServerResp toResponse(McpServer server) {
        McpServerRuntime.RuntimeState state = runtime.state(server.getId(), Boolean.TRUE.equals(server.getEnabled()));
        JSONObject outer = new JSONObject();
        outer.put("mcpServers", Map.of(server.getName(), JSON.parseObject(server.getMcpJson())));
        return new McpServerResp(server.getId(), server.getName(), JSON.toJSONString(outer), Boolean.TRUE.equals(server.getEnabled()),
                state.status(), state.lastError(), state.toolCount(), server.getCreatedAt(), server.getUpdatedAt());
    }

    private McpServer require(String id) {
        if (StrUtil.isBlank(id)) throw new ServiceException("MCP 服务器 ID 不能为空");
        McpServer server = getById(id);
        if (server == null) throw new ServiceException("MCP 服务器不存在");
        return server;
    }

    private McpServer getByName(String name) {
        return lambdaQuery().eq(McpServer::getName, name).one();
    }

    private List<ParsedServer> parseBatch(String rawJson) {
        if (StrUtil.isBlank(rawJson)) throw new ServiceException("MCP 配置不能为空");
        JSONObject root;
        try {
            root = JSON.parseObject(rawJson);
        } catch (Exception e) {
            throw new ServiceException("MCP 配置 JSON 格式错误");
        }
        if (root == null || root.isEmpty() || !root.keySet().equals(Set.of("mcpServers"))) throw new ServiceException("顶层只能包含 mcpServers 字段");
        if (!(root.get("mcpServers") instanceof JSONObject servers) || servers.isEmpty()) throw new ServiceException("mcpServers 必须是非空对象");
        List<ParsedServer> result = new ArrayList<>();
        for (Map.Entry<String, Object> entry : servers.entrySet()) {
            String name = entry.getKey();
            validateName(name);
            if (!(entry.getValue() instanceof JSONObject config)) throw new ServiceException("服务器配置必须是对象: " + name);
            validateConfig(config, name);
            if (config.toJSONString().getBytes(StandardCharsets.UTF_8).length > MAX_CONFIG_BYTES) throw new ServiceException("服务器配置不能超过 64 KB: " + name);
            result.add(new ParsedServer(name, config));
        }
        return result;
    }

    private void validateName(String name) {
        if (StrUtil.isBlank(name) || !name.matches("[A-Za-z0-9_-]+")) throw new ServiceException("MCP 服务器名称只能包含英文字母、数字、下划线和短横线");
    }

    private void validateConfig(JSONObject config, String name) {
        if (config.isEmpty()) throw new ServiceException("服务器配置不能为空: " + name);
        if (!ALLOWED_FIELDS.containsAll(config.keySet())) throw new ServiceException("服务器配置包含未知字段: " + name);
        boolean stdio = config.containsKey("command");
        boolean http = config.containsKey("url");
        if (stdio == http) throw new ServiceException("服务器必须且只能配置 command 或 streamable-http url: " + name);
        if (stdio) {
            if (!STDIO_FIELDS.containsAll(config.keySet()) || !isNonBlankString(config.get("command"))) throw new ServiceException("stdio command 无效: " + name);
            validateStringArray(config.get("args"), "args", name);
            validateStringMap(config.get("env"), "env", name);
            if (config.containsKey("cwd") && !isNonBlankString(config.get("cwd"))) throw new ServiceException("cwd 无效: " + name);
        } else {
            if (!HTTP_FIELDS.containsAll(config.keySet()) || !"streamable-http".equals(config.get("type")) || !isNonBlankString(config.get("url"))) throw new ServiceException("Streamable HTTP 配置无效: " + name);
            validateStringMap(config.get("headers"), "headers", name);
        }
    }

    private boolean isNonBlankString(Object value) {
        return value instanceof String text && StrUtil.isNotBlank(text);
    }

    private void validateStringArray(Object value, String field, String name) {
        if (value == null) return;
        if (!(value instanceof JSONArray array) || array.stream().anyMatch(item -> !(item instanceof String) || StrUtil.isBlank((String) item))) throw new ServiceException(field + " 必须是非空字符串数组: " + name);
    }

    private void validateStringMap(Object value, String field, String name) {
        if (value == null) return;
        if (!(value instanceof JSONObject object) || object.entrySet().stream().anyMatch(entry -> StrUtil.isBlank(entry.getKey()) || !isNonBlankString(entry.getValue()))) throw new ServiceException(field + " 必须是非空字符串键值对象: " + name);
    }

    private record ParsedServer(String name, JSONObject config) {
    }
}
