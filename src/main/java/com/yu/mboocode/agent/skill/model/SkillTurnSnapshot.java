package com.yu.mboocode.agent.skill.model;

import dev.langchain4j.service.tool.ToolProvider;
import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Schema(description = "单个执行 turn 使用的不可变 Skill 快照")
public record SkillTurnSnapshot(
        String sessionId,
        String turnId,
        String workspaceId,
        String workspacePath,
        List<SkillDescriptor> effectiveSkills,
        Map<String, SkillDescriptor> skillsByName,
        String availableSkillsText,
        ToolProvider skillsToolProvider,
        Instant capturedAt
) {
    public SkillTurnSnapshot {
        effectiveSkills = List.copyOf(effectiveSkills);
        skillsByName = Map.copyOf(new LinkedHashMap<>(skillsByName));
        availableSkillsText = availableSkillsText == null ? "" : availableSkillsText;
    }
}
