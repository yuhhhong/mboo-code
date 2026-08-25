package com.yu.mboocode.agent.skill;

import com.yu.mboocode.llm.context.ContextEstimateUtil;

/** Skill 正文边界使用的保守 Token 估算，额外修正中文等非 ASCII 文本的字符口径。 */
public final class SkillTokenEstimator {
    private SkillTokenEstimator() {
    }

    public static long estimate(String modelId, String text) {
        if (text == null || text.isEmpty()) return 0;
        long ascii = 0;
        long nonAscii = 0;
        for (int index = 0; index < text.length();) {
            int codePoint = text.codePointAt(index);
            if (codePoint <= 0x7f) ascii++;
            else nonAscii++;
            index += Character.charCount(codePoint);
        }
        long languageConservative = nonAscii + (ascii + 1) / 2;
        return Math.max(languageConservative, ContextEstimateUtil.estimateTextTokens(modelId, text));
    }
}
