package com.yu.mboocode.llm.prompt;

/**
 * 单个执行 turn 使用的动态系统提示词快照。
 */
public record SystemPromptSnapshot(String runtimeEnvironment, String workspaceInstructions, String availableSkills) {
    public SystemPromptSnapshot {
        runtimeEnvironment = runtimeEnvironment == null ? "" : runtimeEnvironment;
        workspaceInstructions = workspaceInstructions == null ? "" : workspaceInstructions;
        availableSkills = availableSkills == null ? "" : availableSkills;
    }
}
