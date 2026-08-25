package com.yu.mboocode.llm.service;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.yu.mboocode.common.util.DateTimeUtil;
import com.yu.mboocode.llm.mapper.ChatMemoryMapper;
import com.yu.mboocode.llm.model.ChatMemory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 会话上下文持久化。
 *
 * <p>注意：消息、摘要、usage 状态和待写压缩事件必须使用这里的定向更新方法，
 * 不能用带空字段实体的通用 saveOrUpdate，避免普通消息更新意外覆盖摘要状态。</p>
 */
@Service
public class ChatMemoryService extends ServiceImpl<ChatMemoryMapper, ChatMemory> {

    /**
     * 定向更新消息列表；行不存在时插入新行。不触碰摘要和上下文状态字段。
     */
    @Transactional
    public void upsertMessagesJson(String memoryId, String messagesJson) {
        boolean updated = lambdaUpdate()
                .eq(ChatMemory::getMemoryId, memoryId)
                .set(ChatMemory::getMessagesJson, messagesJson)
                .set(ChatMemory::getUpdatedAt, DateTimeUtil.now())
                .update();
        if (!updated) {
            ChatMemory chatMemory = new ChatMemory();
            chatMemory.setMemoryId(memoryId);
            chatMemory.setMessagesJson(messagesJson);
            chatMemory.setUpdatedAt(DateTimeUtil.now());
            save(chatMemory);
        }
    }

    /**
     * 原子提交工具压薄结果并使旧 usage 失效；模型和上下文窗口信息继续保留。
     */
    @Transactional
    public void commitToolThinning(String memoryId, String messagesJson) {
        String now = DateTimeUtil.now();
        boolean updated = lambdaUpdate()
                .eq(ChatMemory::getMemoryId, memoryId)
                .set(ChatMemory::getMessagesJson, messagesJson)
                .set(ChatMemory::getLastContextUsageJson, null)
                .set(ChatMemory::getLastUsageAt, null)
                .set(ChatMemory::getUpdatedAt, now)
                .update();
        if (!updated) {
            ChatMemory chatMemory = new ChatMemory();
            chatMemory.setMemoryId(memoryId);
            chatMemory.setMessagesJson(messagesJson);
            chatMemory.setUpdatedAt(now);
            save(chatMemory);
        }
    }

    /**
     * 保存本轮最后一次有效主模型 usage；摘要模型 usage 不允许走这里。
     */
    @Transactional
    public void saveLastUsage(String memoryId, String modelId, String usageJson, Long contextLimit) {
        String now = DateTimeUtil.now();
        boolean updated = lambdaUpdate()
                .eq(ChatMemory::getMemoryId, memoryId)
                .set(ChatMemory::getLastModelId, modelId)
                .set(ChatMemory::getLastContextUsageJson, usageJson)
                .set(ChatMemory::getLastContextLimit, contextLimit)
                .set(ChatMemory::getLastUsageAt, now)
                .set(ChatMemory::getUpdatedAt, now)
                .update();
        if (!updated) {
            ChatMemory chatMemory = new ChatMemory();
            chatMemory.setMemoryId(memoryId);
            chatMemory.setLastModelId(modelId);
            chatMemory.setLastContextUsageJson(usageJson);
            chatMemory.setLastContextLimit(contextLimit);
            chatMemory.setLastUsageAt(now);
            chatMemory.setUpdatedAt(now);
            save(chatMemory);
        }
    }

    /**
     * 摘要成功后的原子提交：消息、摘要、旧 usage 失效、摘要时间和待写完成事件在一个事务内更新。
     */
    @Transactional
    public void commitCompressionSummary(String memoryId, String messagesJson, String summaryText, String retainedToolResultsJson,
                                         String pendingCompletedEventJson) {
        String now = DateTimeUtil.now();
        boolean updated = lambdaUpdate()
                .eq(ChatMemory::getMemoryId, memoryId)
                .set(ChatMemory::getMessagesJson, messagesJson)
                .set(ChatMemory::getSummaryText, summaryText)
                .set(ChatMemory::getRetainedToolResultsJson, retainedToolResultsJson)
                .set(ChatMemory::getLastContextUsageJson, null)
                .set(ChatMemory::getLastUsageAt, null)
                .set(ChatMemory::getSummaryUpdatedAt, now)
                .set(ChatMemory::getPendingCompressionEventJson, pendingCompletedEventJson)
                .set(ChatMemory::getUpdatedAt, now)
                .update();
        if (!updated) {
            ChatMemory chatMemory = new ChatMemory();
            chatMemory.setMemoryId(memoryId);
            chatMemory.setMessagesJson(messagesJson);
            chatMemory.setSummaryText(summaryText);
            chatMemory.setRetainedToolResultsJson(retainedToolResultsJson);
            chatMemory.setSummaryUpdatedAt(now);
            chatMemory.setPendingCompressionEventJson(pendingCompletedEventJson);
            chatMemory.setUpdatedAt(now);
            save(chatMemory);
        }
    }

    /**
     * 待写完成事件成功落入 JSONL 后清空 pending 字段。
     */
    @Transactional
    public void clearPendingCompressionEvent(String memoryId) {
        lambdaUpdate()
                .eq(ChatMemory::getMemoryId, memoryId)
                .set(ChatMemory::getPendingCompressionEventJson, null)
                .set(ChatMemory::getUpdatedAt, DateTimeUtil.now())
                .update();
    }

    /**
     * 读取当前摘要文本，供系统消息转换器拼入正式系统提示词。
     */
    public String getSummaryText(String memoryId) {
        ChatMemory chatMemory = getById(memoryId);
        return chatMemory == null ? null : chatMemory.getSummaryText();
    }

    /**
     * 读取上下文保留工具结果，供系统消息转换器和 Skill 资源读取校验使用。
     */
    public String getRetainedToolResultsJson(String memoryId) {
        ChatMemory chatMemory = getById(memoryId);
        return chatMemory == null ? null : chatMemory.getRetainedToolResultsJson();
    }
}
