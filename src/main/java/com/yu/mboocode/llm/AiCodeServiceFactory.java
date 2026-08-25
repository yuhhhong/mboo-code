package com.yu.mboocode.llm;

import com.yu.mboocode.agent.tool.ToolApprovalService;
import com.yu.mboocode.agent.tool.ToolRequestValidatorRegistry;
import com.yu.mboocode.agent.tool.permission.ToolPermissionRegistry;
import com.yu.mboocode.agent.skill.CompositeToolProvider;
import com.yu.mboocode.agent.skill.SkillChatRequestTransformer;
import com.yu.mboocode.config.Setting;
import com.yu.mboocode.llm.integration.PermissionToolExecutor;
import com.yu.mboocode.llm.listener.ModelUsageRequestListener;
import com.yu.mboocode.llm.listener.ModelUsageResponseListener;
import com.yu.mboocode.llm.prompt.SystemPromptService;
import com.yu.mboocode.llm.service.ChatMemoryService;
import com.yu.mboocode.llm.service.PersistentChatMemoryStore;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.agent.tool.ToolSpecifications;
import dev.langchain4j.memory.chat.ChatMemoryProvider;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.openai.OpenAiResponsesChatModel;
import dev.langchain4j.model.openai.OpenAiResponsesStreamingChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.tool.AiServiceTool;
import jakarta.annotation.Resource;
import org.springframework.aop.support.AopUtils;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.lang.reflect.Method;
import java.util.*;

@Configuration
public class AiCodeServiceFactory {
    private static final int MAX_MEMORY_MESSAGES = 10_000;

    @Resource
    private Setting setting;
    @Resource
    private PersistentChatMemoryStore persistentChatMemoryStore;
    @Resource
    private ToolApprovalService toolApprovalService;
    @Resource
    private ToolPermissionRegistry toolPermissionRegistry;
    @Resource
    private ToolRequestValidatorRegistry toolRequestValidatorRegistry;
    @Resource
    private ApplicationContext applicationContext;
    @Resource
    private ModelUsageRequestListener modelUsageRequestListener;
    @Resource
    private ModelUsageResponseListener modelUsageResponseListener;
    @Resource
    private ChatMemoryService chatMemoryService;
    @Resource
    private SystemPromptService systemPromptService;
    @Resource
    private CompositeToolProvider compositeToolProvider;
    @Resource
    private SkillChatRequestTransformer skillChatRequestTransformer;

    @Bean
    public ChatMemoryProvider chatMemoryProvider() {
        return memoryId -> MessageWindowChatMemory.builder()
                .id(memoryId)
                .maxMessages(MAX_MEMORY_MESSAGES)
                .alwaysKeepSystemMessageFirst(true)
                .chatMemoryStore(persistentChatMemoryStore)
                .build();
    }

    @Bean
    public AiCodeService getAiCodeService(ChatMemoryProvider chatMemoryProvider) {
        ChatModel chatModel = OpenAiResponsesChatModel
                .builder()
                .apiKey(setting.getApiKey())
                .baseUrl(setting.getBaseUrl())
                .modelName("")
                .build();

        StreamingChatModel streamingChatModel = OpenAiResponsesStreamingChatModel
                .builder()
                .apiKey(setting.getApiKey())
                .baseUrl(setting.getBaseUrl())
                .modelName("")
                .build();

        List<AiServiceTool> tools = discoverTools();

        return AiServices
                .builder(AiCodeService.class)
                .chatModel(chatModel)
                .streamingChatModel(streamingChatModel)
                .chatMemoryProvider(chatMemoryProvider)
                .systemMessageTransformer((systemMessage, invocationContext) -> {
                    // 在基础组合系统提示词后追加会话摘要；不新增第二条系统消息。
                    Object memoryId = invocationContext == null ? null : invocationContext.chatMemoryId();
                    com.yu.mboocode.llm.model.ChatMemory memory = memoryId == null ? null : chatMemoryService.getById(String.valueOf(memoryId));
                    return systemPromptService.appendConversationState(systemMessage, memory == null ? null : memory.getSummaryText(),
                            memory == null ? null : memory.getRetainedToolResultsJson());
                })
                .chatRequestTransformer(skillChatRequestTransformer::transform)
                .tools(tools)
                .toolProvider(compositeToolProvider.toolProvider())
                .registerListeners(modelUsageRequestListener, modelUsageResponseListener)
                .build();
    }

    /**
     * 上下文压缩摘要服务。只配置非流式 ChatModel，不配工具、ChatMemory、系统消息转换器和
     * 主对话 usage 监听器；同时不注册 MyChatModelListener，避免日志记录摘要输入输出正文。
     */
    @Bean
    public ContextSummaryAiService getContextSummaryAiService() {
        ChatModel chatModel = OpenAiResponsesChatModel
                .builder()
                .apiKey(setting.getApiKey())
                .baseUrl(setting.getBaseUrl())
                .modelName("")
                .build();
        return AiServices.builder(ContextSummaryAiService.class).chatModel(chatModel).build();
    }

    private List<AiServiceTool> discoverTools() {
        List<ToolMethod> methods = new ArrayList<>();
        Set<Object> seenBeans = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Object bean : applicationContext.getBeansOfType(Object.class).values()) {
            if (!seenBeans.add(bean)) continue;
            Class<?> targetClass = AopUtils.getTargetClass(bean);
            for (Method method : targetClass.getMethods()) {
                Tool tool = method.getAnnotation(Tool.class);
                if (tool == null) continue;
                String toolName = tool.name() == null || tool.name().isBlank() ? method.getName() : tool.name();
                methods.add(new ToolMethod(toolName, bean, method));
            }
        }
        methods.sort(Comparator.comparing(ToolMethod::toolName).thenComparing(item -> item.method().toGenericString()));
        return methods.stream().map(this::buildPermissionTool).toList();
    }

    private AiServiceTool buildPermissionTool(ToolMethod toolMethod) {
        Method method = toolMethod.method();
        toolPermissionRegistry.register(method);
        ToolSpecification specification = ToolSpecifications.toolSpecificationFrom(method);
        PermissionToolExecutor executor = new PermissionToolExecutor(toolMethod.bean(), method, toolApprovalService, toolRequestValidatorRegistry);
        return AiServiceTool.builder().toolSpecification(specification).toolExecutor(executor).build();
    }

    private record ToolMethod(String toolName, Object bean, Method method) {
    }
}
