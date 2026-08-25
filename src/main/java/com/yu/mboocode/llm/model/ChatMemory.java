package com.yu.mboocode.llm.model;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

/**
 * 模型会话上下文。
 */
@Schema(description = "模型会话上下文")
@TableName(value = "mboo_chat_memory")
@Data
public class ChatMemory {
    @Schema(description = "会话 ID")
    @TableId(value = "memory_id", type = IdType.INPUT)
    private String memoryId;

    @Schema(description = "模型使用的近期聊天消息 JSON")
    private String messagesJson;

    @Schema(description = "早期会话历史摘要")
    private String summaryText;

    @Schema(description = "版本化的上下文保留工具结果 JSON；第一版保存最新 Skill 激活结果")
    private String retainedToolResultsJson;

    @Schema(description = "上一次聊天实际使用的模型 ID；usage 缺失时仍保留，供摘要模型选择")
    private String lastModelId;

    @Schema(description = "最近一次有效主对话 ContextUsageSnapshot JSON；上下文改写后清空")
    private String lastContextUsageJson;

    @Schema(description = "产生该 usage 时模型的上下文窗口")
    private Long lastContextLimit;

    @Schema(description = "最近一次有效主对话 usage 时间")
    private String lastUsageAt;

    @Schema(description = "最近一次模型摘要成功提交时间")
    private String summaryUpdatedAt;

    @Schema(description = "已与摘要一起提交、但尚未确认写入 JSONL 的压缩完成事件 JSON；正常为空")
    private String pendingCompressionEventJson;

    @Schema(description = "会话上下文最近更新时间")
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private String updatedAt;
}
