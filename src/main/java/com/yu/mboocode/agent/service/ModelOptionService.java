package com.yu.mboocode.agent.service;

import cn.hutool.core.util.StrUtil;
import cn.hutool.http.Header;
import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.config.Setting;
import com.yu.mboocode.agent.model.ModelInfo;
import com.yu.mboocode.common.exception.ServiceException;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.Resource;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 应用启动时加载一次模型候选，避免每个前端请求都访问模型供应商。
 */
@Service
@Slf4j
public class ModelOptionService {
    private static final int REQUEST_TIMEOUT = 10_000;
    @Resource
    private Setting setting;
    @Resource
    private ModelMetadataService modelMetadataService;

    @Getter
    private List<String> modelNames = List.of();
    @Getter
    private Map<String, ModelInfo> modelInfoMap = Map.of();

    @PostConstruct
    public void initialize() {
        String apiKey = StrUtil.trim(setting.getApiKey());
        String baseUrl = StrUtil.removeSuffix(StrUtil.trim(setting.getBaseUrl()), "/");
        if (StrUtil.isBlank(apiKey) && StrUtil.isBlank(baseUrl)) {
            // 首次安装允许先启动并进入配置流程；已有配置的供应商错误仍在后续请求中明确失败。
            log.warn("模型服务尚未配置，跳过启动时模型列表加载");
            modelNames = List.of();
            modelInfoMap = Map.of();
            return;
        }
        if (StrUtil.isBlank(apiKey) || StrUtil.isBlank(baseUrl)) {
            throw new IllegalStateException("模型服务配置不完整，请同时填写 api_key 和 base_url");
        }
        Map<String, ModelInfo> metadata = modelMetadataService.loadMetadata();

        String url = baseUrl + "/models";
        try (HttpResponse response = HttpRequest.get(url)
                .header(Header.AUTHORIZATION, "Bearer " + apiKey)
                .header(Header.ACCEPT, "application/json")
                .timeout(REQUEST_TIMEOUT)
                .execute()) {
            if (!response.isOk()) {
                log.error("供应商模型列表请求失败，地址: {}，状态码: {}", url, response.getStatus());
                throw new IllegalStateException("供应商模型列表请求失败");
            }

            String responseBody = response.body();
            if (StrUtil.isBlank(responseBody)) throw new IllegalStateException("供应商模型列表响应为空");
            JSONObject body = JSON.parseObject(responseBody);
            JSONArray data = body == null ? null : body.getJSONArray("data");
            if (data == null) {
                throw new IllegalStateException("供应商模型列表响应缺少 data 数组");
            }

            Set<String> names = new LinkedHashSet<>();
            for (Object item : data) {
                if (!(item instanceof JSONObject model)) continue;
                Object idValue = model.get("id");
                String id = idValue instanceof String text ? text.trim() : null;
                if (StrUtil.isNotBlank(id)) names.add(id);
            }
            if (names.isEmpty()) throw new IllegalStateException("供应商模型列表没有有效模型 ID");

            Map<String, List<ModelInfo>> metadataByNormalizedName = metadata.values().stream()
                    .collect(Collectors.groupingBy(modelInfo -> normalizeModelName(modelInfo.name()), LinkedHashMap::new, Collectors.toList()));
            LinkedHashMap<String, ModelInfo> matched = new LinkedHashMap<>();
            int exactMatchCount = 0;
            int normalizedMatchCount = 0;
            int ambiguousMatchCount = 0;
            for (String name : names) {
                ModelInfo modelInfo = metadata.get(name);
                if (modelInfo != null) {
                    exactMatchCount++;
                } else {
                    String normalizedName = normalizeModelName(name);
                    List<ModelInfo> candidates = StrUtil.isBlank(normalizedName) ? List.of() : metadataByNormalizedName.getOrDefault(normalizedName, List.of());
                    if (candidates.size() == 1) {
                        modelInfo = candidates.get(0);
                        normalizedMatchCount++;
                    } else if (candidates.size() > 1) {
                        ambiguousMatchCount++;
                        log.warn("模型名称归一化匹配存在歧义，供应商模型 ID: {}，候选元数据数量: {}", name, candidates.size());
                    }
                }
                if (modelInfo != null) matched.put(name, bindProviderModelId(name, modelInfo));
            }
            if (matched.isEmpty()) throw new IllegalStateException("供应商模型列表与 models.dev 目录没有匹配模型");
            modelNames = List.copyOf(matched.keySet());
            modelInfoMap = Collections.unmodifiableMap(new LinkedHashMap<>(matched));
            log.info("模型列表加载完成，供应商有效 ID 数: {}，精确匹配数: {}，归一化匹配数: {}，歧义未匹配数: {}，最终匹配数: {}",
                    names.size(), exactMatchCount, normalizedMatchCount, ambiguousMatchCount, modelNames.size());
        } catch (IllegalStateException e) {
            log.error("供应商模型列表加载失败，地址: {}，原因: {}", url, e.getMessage());
            throw e;
        } catch (Exception e) {
            log.error("供应商模型列表加载失败，地址: {}", url, e);
            throw new IllegalStateException("供应商模型列表加载失败", e);
        }
    }

    public ModelInfo requireModelInfo(String modelId) {
        String cleanedModelId = StrUtil.trim(modelId);
        ModelInfo modelInfo = StrUtil.isBlank(cleanedModelId) ? null : modelInfoMap.get(cleanedModelId);
        if (modelInfo == null) throw new ServiceException("模型不存在或未提供能力信息");
        return modelInfo;
    }

    public String validateReasoningEffort(ModelInfo modelInfo, String reasoningEffort) {
        String cleanedEffort = StrUtil.trim(reasoningEffort);
        if (StrUtil.isBlank(cleanedEffort)) return null;
        Set<String> values = new LinkedHashSet<>();
        for (Map<String, Object> option : modelInfo.reasoningOptions()) {
            if (!"effort".equals(option.get("type")) || !(option.get("values") instanceof List<?> optionValues)) continue;
            for (Object value : optionValues) {
                if (!(value instanceof String text)) continue;
                String cleaned = text.trim();
                if (!cleaned.isEmpty()) values.add(cleaned);
            }
        }
        if (!values.contains(cleanedEffort)) throw new ServiceException("当前模型不支持所选思考深度");
        return cleanedEffort;
    }

    private String normalizeModelName(String value) {
        if (StrUtil.isBlank(value)) return "";
        return value.trim().toLowerCase(Locale.ROOT).codePoints()
                .filter(Character::isLetterOrDigit)
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append)
                .toString();
    }

    private ModelInfo bindProviderModelId(String providerModelId, ModelInfo modelInfo) {
        if (providerModelId.equals(modelInfo.modelId())) return modelInfo;
        return new ModelInfo(providerModelId, modelInfo.name(), modelInfo.family(), modelInfo.status(), modelInfo.limit(),
                modelInfo.toolCall(), modelInfo.reasoning(), modelInfo.reasoningOptions(), modelInfo.attachment(),
                modelInfo.inputModalities(), modelInfo.outputModalities());
    }
}
