package com.yu.mboocode.agent.skill.model;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

@Schema(description = "本轮用户 Skill 标签生成的一次性激活计划")
public final class SkillActivationPlan {
    private final String sessionId;
    private final String turnId;
    private final String sanitizedUserMessage;
    private final List<Activation> activations;
    private final AtomicBoolean persisted = new AtomicBoolean();
    private final AtomicBoolean requestInjected = new AtomicBoolean();

    public SkillActivationPlan(String sessionId, String turnId, String sanitizedUserMessage, List<Activation> activations) {
        this.sessionId = sessionId;
        this.turnId = turnId;
        this.sanitizedUserMessage = sanitizedUserMessage;
        this.activations = List.copyOf(activations);
    }

    public String sessionId() {
        return sessionId;
    }

    public String turnId() {
        return turnId;
    }

    public String sanitizedUserMessage() {
        return sanitizedUserMessage;
    }

    public List<Activation> activations() {
        return activations;
    }

    public boolean markPersisted() {
        return persisted.compareAndSet(false, true);
    }

    public boolean markRequestInjected() {
        return requestInjected.compareAndSet(false, true);
    }

    public Set<String> successfulSkillNames() {
        Set<String> names = new LinkedHashSet<>();
        for (Activation activation : activations) {
            if (!activation.error()) names.add(activation.skillName());
        }
        return names;
    }

    public List<ChatMessage> toolMessages() {
        if (activations.isEmpty()) return List.of();
        List<ToolExecutionRequest> requests = activations.stream().map(Activation::request).toList();
        List<ChatMessage> messages = new ArrayList<>();
        messages.add(AiMessage.from(requests));
        for (Activation activation : activations) {
            messages.add(ToolExecutionResultMessage.builder().id(activation.request().id()).toolName(activation.request().name())
                    .text(activation.resultText()).isError(activation.error()).attributes(activation.attributes()).build());
        }
        return List.copyOf(messages);
    }

    public record Activation(String skillName, SkillSource source, String contentHash, ToolExecutionRequest request, String resultText,
                             boolean error, Map<String, Object> attributes) {
        public Activation {
            attributes = Map.copyOf(attributes);
        }
    }
}
