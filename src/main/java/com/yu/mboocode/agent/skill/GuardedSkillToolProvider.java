package com.yu.mboocode.agent.skill;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillResourceDescriptor;
import com.yu.mboocode.common.util.DateTimeUtil;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.invocation.InvocationContext;
import dev.langchain4j.service.tool.AiServiceTool;
import dev.langchain4j.service.tool.ToolExecutionResult;
import dev.langchain4j.service.tool.ToolExecutor;
import dev.langchain4j.service.tool.ToolProvider;
import dev.langchain4j.service.tool.ToolProviderRequest;
import dev.langchain4j.service.tool.ToolProviderResult;
import dev.langchain4j.skills.Skills;

import java.nio.charset.StandardCharsets;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 在 LangChain4j Skills 标准工具规格和执行器外增加 turn、名称、激活状态、路径和规模边界。
 */
public class GuardedSkillToolProvider implements ToolProvider {
    public static final String ACTIVATE_SKILL = "activate_skill";
    public static final String READ_SKILL_RESOURCE = "read_skill_resource";
    public static final long MAX_RESULT_TOKENS = 8192;
    public static final long MAX_RESOURCE_BYTES = 64L * 1024;
    private final String sessionId;
    private final Map<String, SkillDescriptor> skillsByName;
    private final SkillActivationStateService activationStateService;
    private final SkillScriptCache skillScriptCache;
    private final ToolProvider delegate;

    public GuardedSkillToolProvider(String sessionId, List<SkillDescriptor> skills, SkillActivationStateService activationStateService,
                                    SkillScriptCache skillScriptCache) {
        this.sessionId = sessionId;
        Map<String, SkillDescriptor> map = new LinkedHashMap<>();
        skills.forEach(skill -> map.put(skill.name(), skill));
        this.skillsByName = Map.copyOf(map);
        this.activationStateService = activationStateService;
        this.skillScriptCache = skillScriptCache;
        this.delegate = Skills.from(skills.stream().map(SkillDescriptor::skill).toList()).toolProvider();
    }

    @Override
    public ToolProviderResult provideTools(ToolProviderRequest request) {
        if (request.chatMemoryId() == null || !sessionId.equals(String.valueOf(request.chatMemoryId()))) return ToolProviderResult.builder().build();
        ToolProviderResult provided = delegate.provideTools(request);
        ToolProviderResult.Builder builder = ToolProviderResult.builder();
        for (AiServiceTool tool : provided.aiServiceTools()) {
            builder.add(tool.toolSpecification(), new GuardedExecutor(tool.toolExecutor()));
        }
        return builder.build();
    }

    private ToolExecutionResult executeGuarded(ToolExecutionRequest request, InvocationContext context, ToolExecutor delegateExecutor) {
        JSONObject arguments;
        try {
            arguments = JSON.parseObject(request.arguments());
        } catch (RuntimeException e) {
            return error("SKILL_ARGUMENTS_INVALID", "Skill 工具参数不是有效 JSON");
        }
        String skillName = arguments == null ? null : arguments.getString("skill_name");
        SkillDescriptor descriptor = skillsByName.get(skillName);
        if (descriptor == null) return error("SKILL_NOT_FOUND", "当前 turn 中不存在该 Skill");

        if (ACTIVATE_SKILL.equals(request.name())) {
            String activationContent = skillScriptCache.activationContent(descriptor);
            if (SkillTokenEstimator.estimate(modelId(context), activationContent) > MAX_RESULT_TOKENS) {
                return error("SKILL_CONTENT_TOO_LARGE", "Skill 正文超过 8,192 Token 激活上限");
            }
            ToolExecutionResult result = executeDelegate(delegateExecutor, request, context);
            if (result.isError()) return result;
            Map<String, Object> attributes = new LinkedHashMap<>(result.attributes());
            attributes.put("activated_skill", descriptor.name());
            attributes.put("skill_source", descriptor.source().name());
            attributes.put("content_hash", descriptor.contentHash());
            attributes.put("skill_activated_at", DateTimeUtil.now());
            return ToolExecutionResult.builder().isError(false).resultText(activationContent).attributes(attributes).build();
        }

        if (READ_SKILL_RESOURCE.equals(request.name())) {
            if (!activationStateService.activatedSkillNames(sessionId).contains(skillName)) {
                return error("SKILL_NOT_ACTIVATED", "读取 Skill 资源前必须先激活该 Skill");
            }
            String relativePath = normalizeRelative(arguments.getString("relative_path"));
            if (relativePath == null) return error("SKILL_RESOURCE_PATH_INVALID", "Skill 资源路径无效");
            SkillResourceDescriptor resource = descriptor.resources().stream().filter(item -> item.relativePath().equals(relativePath)).findFirst().orElse(null);
            if (resource == null) return error("SKILL_RESOURCE_NOT_FOUND", "Skill 资源不存在");
            if (resource.textContent() == null) return error("SKILL_RESOURCE_NOT_TEXT", "Skill 资源不是有效的 UTF-8 文本");
            if (resource.size() > MAX_RESOURCE_BYTES) return error("SKILL_RESOURCE_TOO_LARGE", "Skill 资源超过 64 KiB 读取上限");
            if (SkillTokenEstimator.estimate(modelId(context), resource.textContent()) > MAX_RESULT_TOKENS) {
                return error("SKILL_RESOURCE_TOO_LARGE", "Skill 资源超过 8,192 Token 读取上限");
            }
            return executeDelegate(delegateExecutor, request, context);
        }
        return error("SKILL_TOOL_UNSUPPORTED", "当前 turn 不支持该 Skill 工具");
    }

    private ToolExecutionResult executeDelegate(ToolExecutor executor, ToolExecutionRequest request, InvocationContext context) {
        try {
            return executor.executeWithContext(request, context);
        } catch (RuntimeException e) {
            return error("SKILL_TOOL_FAILED", "Skill 工具执行失败");
        }
    }

    private ToolExecutionResult error(String code, String message) {
        JSONObject result = new JSONObject();
        result.put("success", false);
        result.put("errorCode", code);
        result.put("errorMessage", message);
        return ToolExecutionResult.builder().isError(true).resultText(result.toJSONString()).attributes(Map.of()).build();
    }

    private String modelId(InvocationContext context) {
        try {
            return context == null || context.defaultRequestParameters() == null ? null : context.defaultRequestParameters().modelName();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private String normalizeRelative(String value) {
        if (StrUtil.isBlank(value) || value.indexOf('\0') >= 0) return null;
        try {
            Path path = Path.of(value.replace('\\', '/')).normalize();
            String normalized = path.toString().replace('\\', '/');
            if (path.isAbsolute() || normalized.isBlank() || normalized.equals("..") || normalized.startsWith("../")) return null;
            return normalized;
        } catch (InvalidPathException e) {
            return null;
        }
    }

    private class GuardedExecutor implements ToolExecutor {
        private final ToolExecutor delegateExecutor;

        private GuardedExecutor(ToolExecutor delegateExecutor) {
            this.delegateExecutor = delegateExecutor;
        }

        @Override
        public String execute(ToolExecutionRequest request, Object memoryId) {
            return executeGuarded(request, null, delegateExecutor).resultText();
        }

        @Override
        public ToolExecutionResult executeWithContext(ToolExecutionRequest request, InvocationContext context) {
            return executeGuarded(request, context, delegateExecutor);
        }
    }
}
