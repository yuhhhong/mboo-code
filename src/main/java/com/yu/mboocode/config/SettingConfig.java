package com.yu.mboocode.config;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONException;
import com.alibaba.fastjson2.JSONWriter;
import com.yu.mboocode.common.util.AppDataPaths;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

@Configuration
public class SettingConfig {
    private static final String SETTING_FILE_NAME = "setting.json";

    @Bean
    public Setting setting() {
        Path settingPath = AppDataPaths.root().resolve(SETTING_FILE_NAME);

        // 应用数据目录在启动项目时创建，这里不用考虑不存在

        if (Files.notExists(settingPath)) {
            writeDefaultSetting(settingPath, Setting.defaultSetting());
        }

        return mergeDefaults(readSetting(settingPath));
    }

    private void writeDefaultSetting(Path settingPath, Setting setting) {
        try {
            String json = JSON.toJSONString(setting, JSONWriter.Feature.PrettyFormat);
            Files.writeString(settingPath, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("创建默认配置文件失败: " + settingPath, e);
        }
    }

    private Setting readSetting(Path settingPath) {
        try {
            String json = Files.readString(settingPath, StandardCharsets.UTF_8);
            Setting setting = JSON.parseObject(json, Setting.class);
            if (setting == null) {
                return Setting.defaultSetting();
            }
            return setting;
        } catch (JSONException e) {
            throw new IllegalStateException("配置文件格式错误: " + settingPath, e);
        } catch (IOException e) {
            throw new IllegalStateException("读取配置文件失败: " + settingPath, e);
        }
    }

    private Setting mergeDefaults(Setting setting) {
        Setting defaults = Setting.defaultSetting();
        List<String> ignoredPatterns = setting.getIgnoredFilePatterns() == null ? Setting.defaultIgnoredFilePatterns() : setting.getIgnoredFilePatterns();
        List<String> ignoredExceptions = setting.getIgnoredFilePatternExceptions() == null ? Setting.defaultIgnoredFilePatternExceptions() : setting.getIgnoredFilePatternExceptions();
        return Setting.builder()
                .apiKey(setting.getApiKey() == null ? defaults.getApiKey() : setting.getApiKey())
                .baseUrl(setting.getBaseUrl() == null ? defaults.getBaseUrl() : setting.getBaseUrl())
                .webSearchExaApiKey(setting.getWebSearchExaApiKey() == null ? defaults.getWebSearchExaApiKey() : setting.getWebSearchExaApiKey())
                .webFetchPrivateNetworkEnabled(setting.getWebFetchPrivateNetworkEnabled() == null ? defaults.getWebFetchPrivateNetworkEnabled() : setting.getWebFetchPrivateNetworkEnabled())
                .ignoredFilePatterns(ignoredPatterns)
                .ignoredFilePatternExceptions(ignoredExceptions)
                .build();
    }
}
