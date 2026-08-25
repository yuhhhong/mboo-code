package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.skill.model.SkillActivationPlan;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 计划按 sessionId + turnId 存活于进程内，不依赖线程绑定；一个会话同一时间只有一个执行 turn。
 */
@Component
public class SkillActivationPlanRegistry {
    private final Map<String, SkillActivationPlan> plans = new ConcurrentHashMap<>();

    public void put(SkillActivationPlan plan) {
        plans.put(plan.sessionId(), plan);
    }

    public SkillActivationPlan get(String sessionId) {
        return sessionId == null ? null : plans.get(sessionId);
    }

    public SkillActivationPlan get(String sessionId, String turnId) {
        SkillActivationPlan plan = get(sessionId);
        return plan != null && plan.turnId().equals(turnId) ? plan : null;
    }

    public void remove(String sessionId, String turnId) {
        SkillActivationPlan plan = plans.get(sessionId);
        if (plan != null && plan.turnId().equals(turnId)) plans.remove(sessionId, plan);
    }
}
