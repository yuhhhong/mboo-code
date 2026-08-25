package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.service.McpServerRuntime;
import dev.langchain4j.service.tool.AiServiceTool;
import dev.langchain4j.service.tool.ToolProvider;
import dev.langchain4j.service.tool.ToolProviderRequest;
import dev.langchain4j.service.tool.ToolProviderResult;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

/** 合并 MCP 与 Skill 两类动态工具，并在规格名称冲突时丢弃本 turn 的 Skill Provider。 */
@Component
@Slf4j
public class CompositeToolProvider {
    @Resource
    private McpServerRuntime mcpServerRuntime;
    @Resource
    private SkillRuntime skillRuntime;

    private final ToolProvider toolProvider = this::provideTools;

    public ToolProvider toolProvider() {
        return toolProvider;
    }

    private ToolProviderResult provideTools(ToolProviderRequest request) {
        ToolProviderResult mcp = mcpServerRuntime.toolProvider().provideTools(request);
        ToolProviderResult skill;
        try {
            skill = skillRuntime.toolProvider().provideTools(request);
        } catch (RuntimeException e) {
            log.warn("当前 turn 的 Skill 工具加载失败 sessionId:{}", request.chatMemoryId());
            return mcp;
        }
        Set<String> names = new HashSet<>();
        for (AiServiceTool tool : mcp.aiServiceTools()) names.add(tool.name());
        if (skill.aiServiceTools().stream().anyMatch(tool -> !names.add(tool.name()))) {
            log.warn("当前 turn 的 Skill 工具名称冲突 sessionId:{}", request.chatMemoryId());
            return mcp;
        }
        return ToolProviderResult.builder().addAll(mcp.aiServiceTools()).addAll(skill.aiServiceTools()).build();
    }
}
