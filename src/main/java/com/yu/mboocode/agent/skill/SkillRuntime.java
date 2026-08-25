package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillTurnSnapshot;
import dev.langchain4j.service.tool.ToolProvider;
import dev.langchain4j.service.tool.ToolProviderRequest;
import dev.langchain4j.service.tool.ToolProviderResult;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Skill turn 快照运行时。 */
@Service
public class SkillRuntime {
    @Resource
    private SkillRegistry skillRegistry;
    @Resource
    private SkillActivationStateService activationStateService;
    @Resource
    private SkillScriptCache skillScriptCache;

    private final Map<String, SkillTurnSnapshot> snapshots = new ConcurrentHashMap<>();
    private final ToolProvider toolProvider = this::provideTools;

    public void captureTurnSnapshot(String sessionId, String turnId, String workspaceId, String workspacePath) {
        List<SkillDescriptor> skills = skillRegistry.effectiveSkills(workspaceId, workspacePath);
        Map<String, SkillDescriptor> skillsByName = new LinkedHashMap<>();
        skills.forEach(skill -> skillsByName.put(skill.name(), skill));
        ToolProvider provider = skills.isEmpty() ? request -> ToolProviderResult.builder().build()
                : new GuardedSkillToolProvider(sessionId, skills, activationStateService, skillScriptCache);
        snapshots.put(sessionId, new SkillTurnSnapshot(sessionId, turnId, workspaceId, workspacePath, skills, skillsByName,
                skillRegistry.formatAvailableSkills(skills), provider, Instant.now()));
    }

    public SkillTurnSnapshot requireSnapshot(String sessionId, String turnId) {
        SkillTurnSnapshot snapshot = snapshots.get(sessionId);
        if (snapshot == null || !snapshot.turnId().equals(turnId)) throw new IllegalStateException("当前 turn 的 Skill 快照不存在");
        return snapshot;
    }

    public SkillTurnSnapshot snapshot(String sessionId) {
        return snapshots.get(sessionId);
    }

    public String availableSkills(String sessionId) {
        SkillTurnSnapshot snapshot = snapshots.get(sessionId);
        return snapshot == null ? "" : snapshot.availableSkillsText();
    }

    public ToolProvider toolProvider() {
        return toolProvider;
    }

    public boolean isSkillTool(String toolName) {
        return GuardedSkillToolProvider.ACTIVATE_SKILL.equals(toolName) || GuardedSkillToolProvider.READ_SKILL_RESOURCE.equals(toolName);
    }

    public void releaseTurnSnapshot(String sessionId, String turnId) {
        SkillTurnSnapshot snapshot = snapshots.get(sessionId);
        if (snapshot != null && snapshot.turnId().equals(turnId)) snapshots.remove(sessionId, snapshot);
    }

    private ToolProviderResult provideTools(ToolProviderRequest request) {
        String sessionId = request.chatMemoryId() == null ? null : String.valueOf(request.chatMemoryId());
        SkillTurnSnapshot snapshot = sessionId == null ? null : snapshots.get(sessionId);
        return snapshot == null ? ToolProviderResult.builder().build() : snapshot.skillsToolProvider().provideTools(request);
    }
}
