package com.yu.mboocode.agent.skill.dto;

import com.yu.mboocode.agent.skill.model.SkillSource;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Skill 输入联想项")
public record SkillSuggestResp(String name, String description, SkillSource source) {
}
