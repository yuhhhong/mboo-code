package com.yu.mboocode.agent.controller;

import com.yu.mboocode.agent.dto.DesktopHealthResp;
import com.yu.mboocode.common.dto.R;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "桌面端")
@RestController
@RequestMapping("/desktop")
public class DesktopHealthController {
    private final String version;
    private final String instanceId;

    public DesktopHealthController(@Value("${mboo.version}") String version,
                                   @Value("${MBOO_INSTANCE_ID:}") String instanceId) {
        this.version = version;
        this.instanceId = instanceId;
    }

    /**
     * 提供 Electron 启动状态机所需的最小存活与归属证明，不复用会话或配置接口以避免扩大信息暴露面。
     */
    @Operation(summary = "桌面端服务健康检查")
    @GetMapping("/health")
    public R<DesktopHealthResp> health() {
        return R.ok(new DesktopHealthResp("UP", version, instanceId));
    }
}
