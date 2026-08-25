package com.yu.mboocode.agent.skill.model;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Skill 资源描述")
public record SkillResourceDescriptor(
        @Schema(description = "Skill 根目录内的规范化相对路径") String relativePath,
        @Schema(description = "资源大小，单位字节") long size,
        @Schema(description = "是否位于 scripts 目录") boolean script,
        @Schema(description = "UTF-8 文本；二进制或非法 UTF-8 资源为空") String textContent
) {
}
