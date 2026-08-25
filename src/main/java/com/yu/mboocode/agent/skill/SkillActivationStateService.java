package com.yu.mboocode.agent.skill;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.agent.skill.model.SkillActivationPlan;
import com.yu.mboocode.llm.model.ChatMemory;
import com.yu.mboocode.llm.service.ChatMemoryService;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ChatMessageDeserializer;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Service;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 汇总当前 ChatMemory、摘要后保留状态和本轮显式计划中的已激活 Skill。
 */
@Service
public class SkillActivationStateService {
    @Resource
    private ChatMemoryService chatMemoryService;
    @Resource
    private SkillActivationPlanRegistry planRegistry;

    public Set<String> activatedSkillNames(String sessionId) {
        Set<String> names = new LinkedHashSet<>();
        ChatMemory memory = chatMemoryService.getById(sessionId);
        if (memory != null && StrUtil.isNotBlank(memory.getMessagesJson())) {
            try {
                List<ChatMessage> messages = ChatMessageDeserializer.messagesFromJson(memory.getMessagesJson());
                for (ChatMessage message : messages) {
                    if (message instanceof ToolExecutionResultMessage result) addActivatedName(names, result.attributes().get("activated_skill"));
                }
            } catch (RuntimeException ignored) {
                // 损坏的历史消息由上下文层处理；Skill 边界按未激活继续拒绝资源读取。
            }
        }
        if (memory != null && StrUtil.isNotBlank(memory.getRetainedToolResultsJson())) {
            try {
                JSONObject root = JSON.parseObject(memory.getRetainedToolResultsJson());
                JSONArray entries = root == null ? null : root.getJSONArray("entries");
                if (entries != null) {
                    for (Object value : entries) {
                        if (!(value instanceof JSONObject entry)) continue;
                        JSONObject attributes = entry.getJSONObject("attributes");
                        addActivatedName(names, attributes == null ? null : attributes.get("activated_skill"));
                    }
                }
            } catch (RuntimeException ignored) {
                // 保留状态解析失败时不扩大资源读取权限。
            }
        }
        SkillActivationPlan plan = planRegistry.get(sessionId);
        if (plan != null) names.addAll(plan.successfulSkillNames());
        return names;
    }

    private void addActivatedName(Set<String> names, Object value) {
        if (value instanceof String name && !name.isBlank()) names.add(name);
    }
}
