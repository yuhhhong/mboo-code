package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 宽松解析用户消息中的严格 Skill 标签：只移除当前快照中真实存在的合法标签，其他原文保持不变。
 */
@Component
public class SkillTagParser {
    private static final Pattern TAG_PATTERN = Pattern.compile("<skill>([a-z0-9]+(?:-[a-z0-9]+)*)</skill>");

    public ParsedSkillTags parse(String userMessage, Map<String, SkillDescriptor> skillsByName) {
        String source = userMessage == null ? "" : userMessage;
        Matcher matcher = TAG_PATTERN.matcher(source);
        StringBuilder sanitized = new StringBuilder(source.length());
        Set<String> names = new LinkedHashSet<>();
        int previousEnd = 0;
        while (matcher.find()) {
            String name = matcher.group(1);
            if (!skillsByName.containsKey(name)) continue;
            sanitized.append(source, previousEnd, matcher.start());
            previousEnd = matcher.end();
            names.add(name);
        }
        sanitized.append(source, previousEnd, source.length());
        return new ParsedSkillTags(sanitized.toString(), new ArrayList<>(names));
    }

    public record ParsedSkillTags(String sanitizedUserMessage, List<String> skillNames) {
    }
}
