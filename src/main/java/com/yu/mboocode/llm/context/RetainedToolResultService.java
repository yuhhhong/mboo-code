package com.yu.mboocode.llm.context;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.yu.mboocode.common.exception.ServiceException;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 解析、合并、去重并按动态 Token 上限裁剪上下文保留工具结果。 */
@Service
public class RetainedToolResultService {
    private static final long MIN_TOTAL_TOKENS = 8192;
    private static final long MAX_TOTAL_TOKENS = 16384;
    private static final long ROUNDING_TOKENS = 1024;

    public RetainedToolResults parse(String json) {
        if (StrUtil.isBlank(json)) return RetainedToolResults.empty();
        try {
            RetainedToolResults results = JSON.parseObject(json, RetainedToolResults.class);
            if (results == null || results.version() != 1 || results.entries() == null) return RetainedToolResults.empty();
            return results;
        } catch (RuntimeException e) {
            return RetainedToolResults.empty();
        }
    }

    public RetainedToolResults merge(String existingJson, List<RetainedToolResult> extracted, long effectiveContextLimit, String modelId) {
        Map<String, RetainedToolResult> byKey = new LinkedHashMap<>();
        for (RetainedToolResult entry : parse(existingJson).entries()) {
            if (StrUtil.isNotBlank(entry.retentionKey())) byKey.put(entry.retentionKey(), entry);
        }
        for (RetainedToolResult entry : extracted) {
            if (StrUtil.isBlank(entry.retentionKey())) continue;
            byKey.remove(entry.retentionKey());
            byKey.put(entry.retentionKey(), entry);
        }
        List<RetainedToolResult> entries = new ArrayList<>(byKey.values());
        long limit = retainedTotalLimit(effectiveContextLimit);
        while (estimatedTokens(entries, modelId) > limit && entries.size() > 1) entries.removeFirst();
        if (estimatedTokens(entries, modelId) > limit) throw new ServiceException("最新 Skill 激活结果超过上下文保留上限");
        return new RetainedToolResults(1, entries);
    }

    public String serialize(RetainedToolResults results) {
        if (results == null || results.entries().isEmpty()) return null;
        return JSON.toJSONString(results);
    }

    public long retainedTotalLimit(long effectiveContextLimit) {
        long ratioTokens = (long) Math.ceil(effectiveContextLimit * 0.10);
        long rounded = ((ratioTokens + ROUNDING_TOKENS - 1) / ROUNDING_TOKENS) * ROUNDING_TOKENS;
        return Math.min(MAX_TOTAL_TOKENS, Math.max(MIN_TOTAL_TOKENS, rounded));
    }

    private long estimatedTokens(List<RetainedToolResult> entries, String modelId) {
        long total = 0;
        for (RetainedToolResult entry : entries) total += ContextEstimateUtil.estimateTextTokens(modelId, JSON.toJSONString(entry));
        return total;
    }
}
