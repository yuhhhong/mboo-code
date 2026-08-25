package com.yu.mboocode.agent.skill;

import cn.hutool.core.util.IdUtil;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.agent.enums.SessionEventSource;
import com.yu.mboocode.agent.enums.SessionEventType;
import com.yu.mboocode.agent.model.SessionEvent;
import com.yu.mboocode.agent.model.SessionTurn;
import com.yu.mboocode.agent.model.ToolResultArtifact;
import com.yu.mboocode.agent.model.payload.ToolCallEndedPayload;
import com.yu.mboocode.agent.model.payload.ToolCallStartedPayload;
import com.yu.mboocode.agent.service.SessionEventStore;
import com.yu.mboocode.agent.service.ToolResultStore;
import com.yu.mboocode.agent.skill.model.SkillActivationPlan;
import com.yu.mboocode.agent.skill.model.SkillActivationPlan.Activation;
import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillTurnSnapshot;
import com.yu.mboocode.agent.tool.event.ToolEventFormatterRegistry;
import com.yu.mboocode.common.util.DateTimeUtil;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.memory.chat.ChatMemoryProvider;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把用户标签转换为与 activate_skill 相同的合法模拟工具调用、结果、事件和结果制品。
 */
@Service
public class SkillActivationService {
    @Resource
    private SkillRuntime skillRuntime;
    @Resource
    private SkillTagParser skillTagParser;
    @Resource
    private SkillActivationPlanRegistry planRegistry;
    @Resource
    private ChatMemoryProvider chatMemoryProvider;
    @Resource
    private SessionEventStore sessionEventStore;
    @Resource
    private ToolResultStore toolResultStore;
    @Resource
    private ToolEventFormatterRegistry toolEventFormatterRegistry;
    @Resource
    private SkillScriptCache skillScriptCache;

    public SkillActivationPlan createPlan(SessionTurn sessionTurn, String rawUserMessage, String modelId) {
        SkillTurnSnapshot snapshot = skillRuntime.requireSnapshot(sessionTurn.sessionId(), sessionTurn.turnId());
        SkillTagParser.ParsedSkillTags parsed = skillTagParser.parse(rawUserMessage, snapshot.skillsByName());
        List<Activation> activations = new ArrayList<>();
        for (String skillName : parsed.skillNames()) {
            SkillDescriptor descriptor = snapshot.skillsByName().get(skillName);
            String activationContent = skillScriptCache.activationContent(descriptor);
            ToolExecutionRequest request = ToolExecutionRequest.builder().id(IdUtil.getSnowflakeNextIdStr())
                    .name(GuardedSkillToolProvider.ACTIVATE_SKILL).arguments(new JSONObject(Map.of("skill_name", skillName)).toJSONString()).build();
            boolean error = SkillTokenEstimator.estimate(modelId, activationContent) > GuardedSkillToolProvider.MAX_RESULT_TOKENS;
            String resultText = error ? errorResult("SKILL_CONTENT_TOO_LARGE", "Skill 正文超过 8,192 Token 激活上限") : activationContent;
            Map<String, Object> attributes = new LinkedHashMap<>();
            if (!error) {
                attributes.put("activated_skill", skillName);
                attributes.put("skill_source", descriptor.source().name());
                attributes.put("content_hash", descriptor.contentHash());
                attributes.put("skill_activated_at", DateTimeUtil.now());
            }
            activations.add(new Activation(skillName, descriptor.source(), descriptor.contentHash(), request, resultText, error, attributes));
        }
        SkillActivationPlan plan = new SkillActivationPlan(sessionTurn.sessionId(), sessionTurn.turnId(), parsed.sanitizedUserMessage(), activations);
        if (!activations.isEmpty()) planRegistry.put(plan);
        return plan;
    }

    /**
     * 在 TokenStream.start 前把工具组追加到 ChatMemory，并落通用工具事件和结果制品。
     */
    public List<SessionEvent> persistPlan(SessionTurn sessionTurn, String assistantMessageId, SkillActivationPlan plan) {
        if (plan.activations().isEmpty() || !plan.markPersisted()) return List.of();
        ChatMemory memory = chatMemoryProvider.get(sessionTurn.sessionId());
        for (ChatMessage message : plan.toolMessages()) memory.add(message);

        List<SessionEvent> events = new ArrayList<>();
        for (Activation activation : plan.activations()) {
            ToolExecutionRequest request = activation.request();
            SessionEvent started = sessionEventStore.appendSession(sessionTurn.transcriptUri(), sessionTurn.sessionId(), sessionTurn.turnId(),
                    SessionEventType.TOOL_CALL_STARTED, SessionEventSource.SYSTEM, ToolCallStartedPayload.builder().messageId(assistantMessageId)
                            .toolCallId(request.id()).toolName(request.name())
                            .arguments(toolEventFormatterRegistry.formatArguments(request.name(), request.arguments())).build());
            events.add(started);

            ToolCallEndedPayload.ToolCallStatus status = activation.error() ? ToolCallEndedPayload.ToolCallStatus.FAILED : ToolCallEndedPayload.ToolCallStatus.COMPLETED;
            String preview = activation.error() ? "Skill 激活失败" : "已激活 Skill：" + activation.skillName();
            ToolResultArtifact artifact = toolResultStore.saveResult(sessionTurn.transcriptUri(), sessionTurn.sessionId(), sessionTurn.turnId(),
                    assistantMessageId, request.id(), request.name(), status, activation.resultText(), preview);
            SessionEvent ended = sessionEventStore.appendSession(sessionTurn.transcriptUri(), sessionTurn.sessionId(), sessionTurn.turnId(),
                    SessionEventType.TOOL_CALL_ENDED, SessionEventSource.SYSTEM, ToolCallEndedPayload.builder().messageId(assistantMessageId)
                            .toolCallId(request.id()).toolName(request.name())
                            .arguments(toolEventFormatterRegistry.formatArguments(request.name(), request.arguments())).status(status)
                            .resultId(artifact.getResultId()).resultSizeBytes(artifact.getResultSizeBytes())
                            .rawOutputAvailable(artifact.getRawOutputAvailable()).errorCode(activation.error() ? "SKILL_CONTENT_TOO_LARGE" : null)
                            .errorMessage(activation.error() ? "Skill 正文超过 8,192 Token 激活上限" : null).durationMs(0L).build());
            events.add(ended);
        }
        return events;
    }

    private String errorResult(String code, String message) {
        JSONObject result = new JSONObject();
        result.put("success", false);
        result.put("errorCode", code);
        result.put("errorMessage", message);
        return result.toJSONString();
    }
}
