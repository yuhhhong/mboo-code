package com.yu.mboocode.agent.skill.model;

import dev.langchain4j.skills.Skill;
import io.swagger.v3.oas.annotations.media.Schema;

import java.nio.file.Path;
import java.util.List;

/**
 * 一次扫描得到的 Skill 描述。正文、资源和 LangChain4j Skill 均在扫描时固定，
 * 因而可以直接进入不可变 turn 快照。
 */
@Schema(description = "Skill 描述")
public record SkillDescriptor(
        @Schema(description = "Skill 名称") String name,
        @Schema(description = "Skill 描述") String description,
        @Schema(description = "SKILL.md 去除 Front Matter 后的正文") String content,
        @Schema(description = "完整 SKILL.md") String skillMarkdown,
        @Schema(description = "物理来源") SkillSource source,
        @Schema(description = "作用域") SkillScope scope,
        @Schema(description = "项目级 Skill 所属工作区 ID") String workspaceId,
        @Schema(description = "项目级 Skill 所属工作区名称") String workspaceName,
        @Schema(description = "校验状态") SkillStatus status,
        @Schema(description = "无效项的中文错误摘要") String errorMessage,
        @Schema(description = "SKILL.md 原始字节数") long contentSize,
        @Schema(description = "Skill 文件树总字节数") long totalSize,
        @Schema(description = "文件数量") int fileCount,
        @Schema(description = "资源列表") List<SkillResourceDescriptor> resources,
        @Schema(description = "规范化文件树 SHA-256") String contentHash,
        Path rootPath,
        Skill skill
) {
    public SkillDescriptor {
        resources = resources == null ? List.of() : List.copyOf(resources);
    }

    public int resourceCount() {
        return resources.size();
    }
}
