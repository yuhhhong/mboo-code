package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.skill.model.SkillActivationPlan;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.model.chat.request.ChatRequest;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/** 主 AiCodeService 的一次性 ChatRequest 注入器；摘要服务不注册。 */
@Component
public class SkillChatRequestTransformer {
    @Resource
    private SkillActivationPlanRegistry planRegistry;
    @Resource
    private SkillRuntime skillRuntime;

    public ChatRequest transform(ChatRequest request, Object memoryId) {
        if (memoryId == null) return request;
        String sessionId = String.valueOf(memoryId);
        SkillActivationPlan plan = planRegistry.get(sessionId);
        var snapshot = skillRuntime.snapshot(sessionId);
        if (plan == null || snapshot == null || !snapshot.turnId().equals(plan.turnId())) return request;
        if (plan.activations().isEmpty() || !plan.markRequestInjected()) return request;
        List<ChatMessage> messages = new ArrayList<>(request.messages());
        messages.addAll(plan.toolMessages());
        return request.toBuilder().messages(messages).build();
    }
}
