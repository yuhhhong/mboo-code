package com.yu.mboocode.agent.skill.dto;

import com.yu.mboocode.agent.skill.model.SkillSource;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Skill 导入前解析与冲突预览")
public record SkillImportPreviewResp(
        String name,
        String description,
        SkillSource targetSource,
        String workspaceId,
        String workspaceName,
        String targetDisplayPath,
        long contentSize,
        long totalSize,
        int fileCount,
        int resourceCount,
        String contentHash,
        boolean conflict
) {
}
