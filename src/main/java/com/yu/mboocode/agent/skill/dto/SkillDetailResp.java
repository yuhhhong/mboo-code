package com.yu.mboocode.agent.skill.dto;

import com.yu.mboocode.agent.skill.model.SkillScope;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.agent.skill.model.SkillStatus;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

@Schema(description = "Skill 详情")
public record SkillDetailResp(
        String name,
        String description,
        SkillSource source,
        SkillScope scope,
        String workspaceId,
        String workspaceName,
        SkillStatus status,
        String errorMessage,
        String skillMarkdown,
        long contentSize,
        long totalSize,
        int fileCount,
        String contentHash,
        List<SkillResourceResp> resources,
        @Schema(description = "按 resource 参数读取的资源相对路径") String resourcePath,
        @Schema(description = "按需读取的 UTF-8 资源正文") String resourceContent
) {
}
