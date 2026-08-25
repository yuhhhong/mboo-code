package com.yu.mboocode.llm.context;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 按工具名选择压薄、摘要和摘要后保留策略。 */
@Component
public class ToolMemoryPolicyRegistry {
    private static final ToolMemoryPolicy DEFAULT_POLICY = new FixedPolicy(true, true, false);
    private static final ToolMemoryPolicy ACTIVATE_SKILL_POLICY = new FixedPolicy(false, false, true);
    private static final ToolMemoryPolicy READ_SKILL_RESOURCE_POLICY = new FixedPolicy(false, true, false);
    private static final Map<String, ToolMemoryPolicy> POLICIES = Map.of(
            "activate_skill", ACTIVATE_SKILL_POLICY,
            "read_skill_resource", READ_SKILL_RESOURCE_POLICY
    );

    public ToolMemoryPolicy policy(String toolName) {
        return POLICIES.getOrDefault(toolName, DEFAULT_POLICY);
    }

    private record FixedPolicy(boolean shouldThin, boolean shouldSummarize, boolean retained) implements ToolMemoryPolicy {
        @Override
        public boolean shouldThin(ToolCallGroup toolGroup) {
            return shouldThin;
        }

        @Override
        public boolean shouldSummarize(ToolCallGroup toolGroup) {
            return shouldSummarize;
        }

        @Override
        public String retentionKey(ToolCallGroup toolGroup) {
            if (!retained) return null;
            try {
                JSONObject arguments = JSON.parseObject(toolGroup.request().arguments());
                String skillName = arguments == null ? null : arguments.getString("skill_name");
                return skillName == null || skillName.isBlank() ? null : toolGroup.request().name() + ":" + skillName;
            } catch (RuntimeException e) {
                return null;
            }
        }
    }
}
