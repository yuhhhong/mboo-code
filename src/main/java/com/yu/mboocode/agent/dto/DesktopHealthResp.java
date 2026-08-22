package com.yu.mboocode.agent.dto;

/**
 * 桌面壳验证 Java sidecar 归属时使用的最小只读响应，避免将业务数据或本地敏感配置暴露给健康检查调用方。
 */
public record DesktopHealthResp(String status, String version, String instanceId) {
}
