package com.yu.mboocode.agent.model;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

@Schema(description = "MCP 服务器配置")
@TableName("mboo_mcp_servers")
@Data
public class McpServer {
    @Schema(description = "MCP 服务器 ID")
    @TableId(type = IdType.ASSIGN_ID)
    private String id;

    @Schema(description = "服务器名称，大小写不敏感")
    private String name;

    @Schema(description = "单个服务器配置对象 JSON")
    private String mcpJson;

    @Schema(description = "是否启用")
    private Boolean enabled;

    @Schema(description = "创建时间")
    @TableField(fill = FieldFill.INSERT)
    private String createdAt;

    @Schema(description = "更新时间")
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private String updatedAt;
}
