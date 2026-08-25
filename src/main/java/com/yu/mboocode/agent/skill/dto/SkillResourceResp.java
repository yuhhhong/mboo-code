package com.yu.mboocode.agent.skill.dto;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Skill 资源")
public record SkillResourceResp(
        @Schema(description = "规范化相对路径") String relativePath,
        @Schema(description = "资源大小，单位字节") long size,
        @Schema(description = "是否为脚本") boolean script,
        @Schema(description = "是否可按 UTF-8 文本查看") boolean textReadable
) {
}
