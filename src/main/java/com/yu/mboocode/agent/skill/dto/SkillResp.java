package com.yu.mboocode.agent.skill.dto;

import com.yu.mboocode.agent.skill.model.SkillScope;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.agent.skill.model.SkillStatus;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Skill 列表项")
public record SkillResp(
        @Schema(description = "Skill 名称") String name,
        @Schema(description = "Skill 描述") String description,
        @Schema(description = "物理来源") SkillSource source,
        @Schema(description = "作用域") SkillScope scope,
        @Schema(description = "项目工作区 ID") String workspaceId,
        @Schema(description = "项目工作区名称") String workspaceName,
        @Schema(description = "校验状态") SkillStatus status,
        @Schema(description = "无效项错误摘要") String errorMessage,
        @Schema(description = "是否为当前上下文中的生效版本") boolean effective,
        @Schema(description = "覆盖当前项的来源") SkillSource shadowedBy,
        @Schema(description = "SKILL.md 字节数") long contentSize,
        @Schema(description = "文件树总字节数") long totalSize,
        @Schema(description = "文件数量") int fileCount,
        @Schema(description = "资源数量") int resourceCount,
        @Schema(description = "内容 hash") String contentHash,
        @Schema(description = "是否允许删除") boolean canDelete,
        @Schema(description = "是否允许替换") boolean canReplace
) {
}
