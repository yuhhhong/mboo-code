package com.yu.mboocode.agent.skill.model;

import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * Skill 物理来源，枚举顺序同时表示同名 Skill 的生效优先级。
 */
@AllArgsConstructor
@Getter
public enum SkillSource {
    PROJECT_MBOO(SkillScope.PROJECT, true),
    PROJECT_AGENTS(SkillScope.PROJECT, false),
    GLOBAL_MBOO(SkillScope.GLOBAL, true),
    GLOBAL_AGENTS(SkillScope.GLOBAL, false),
    BUILTIN(SkillScope.BUILTIN, false);

    private final SkillScope scope;
    private final boolean manageable;
}
