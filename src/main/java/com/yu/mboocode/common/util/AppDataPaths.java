package com.yu.mboocode.common.util;

import cn.hutool.core.util.StrUtil;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * 统一解析应用私有数据目录，确保数据库、配置、会话和缓存使用同一个根目录。
 */
public final class AppDataPaths {
    private static final String APP_DATA_DIR_PROPERTY = "mboo.appDataDir";
    private static final String DEFAULT_DIRECTORY_NAME = ".mboo";

    private AppDataPaths() {
    }

    public static Path root() {
        String configuredPath = System.getProperty(APP_DATA_DIR_PROPERTY);
        try {
            if (StrUtil.isNotBlank(configuredPath)) return Path.of(configuredPath).toAbsolutePath().normalize();
            String userHome = System.getProperty("user.home");
            if (StrUtil.isBlank(userHome)) throw new IllegalStateException("无法确定用户目录");
            return Path.of(userHome, DEFAULT_DIRECTORY_NAME).toAbsolutePath().normalize();
        } catch (InvalidPathException e) {
            throw new IllegalStateException("应用数据目录路径无效", e);
        }
    }

    public static Path initialize() {
        Path root = root();
        try {
            if (Files.exists(root) && !Files.isDirectory(root)) throw new IllegalStateException("应用数据目录不是有效目录: " + root);
            Files.createDirectories(root);
            if (!Files.isDirectory(root)) throw new IllegalStateException("应用数据目录不是有效目录: " + root);
            Path realRoot = root.toRealPath();
            System.setProperty(APP_DATA_DIR_PROPERTY, realRoot.toString());
            return realRoot;
        } catch (IOException | SecurityException e) {
            throw new IllegalStateException("创建应用数据目录失败: " + root, e);
        }
    }
}
