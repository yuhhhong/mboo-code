package com.yu.mboocode.config;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * mboo_chat_memory 上下文状态字段的轻量迁移。
 *
 * <p>schema.sql 只对新库生效；已有 SQLite 库在启动时按 PRAGMA table_info 补齐缺失列，
 * 旧行新增字段按空状态处理。</p>
 */
@Configuration
@Slf4j
public class ChatMemorySchemaMigration {
    private static final String TABLE = "mboo_chat_memory";

    /**
     * 列名 -> 列定义；只追加不修改，保证对旧库幂等。
     */
    private static final Map<String, String> CONTEXT_COLUMNS = Map.ofEntries(
            Map.entry("retained_tool_results_json", "TEXT"),
            Map.entry("last_model_id", "TEXT"),
            Map.entry("last_context_usage_json", "TEXT"),
            Map.entry("last_context_limit", "INTEGER"),
            Map.entry("last_usage_at", "TEXT"),
            Map.entry("summary_updated_at", "TEXT"),
            Map.entry("pending_compression_event_json", "TEXT")
    );

    @Resource
    private JdbcTemplate jdbcTemplate;

    @PostConstruct
    public void migrate() {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList("PRAGMA table_info(" + TABLE + ")");
        if (rows.isEmpty()) {
            // 表尚未创建时由 schema.sql 负责建表，无需补列
            return;
        }
        Set<String> existingColumns = new HashSet<>();
        for (Map<String, Object> row : rows) {
            existingColumns.add(String.valueOf(row.get("name")));
        }
        for (Map.Entry<String, String> column : CONTEXT_COLUMNS.entrySet()) {
            if (existingColumns.contains(column.getKey())) {
                continue;
            }
            jdbcTemplate.execute("ALTER TABLE " + TABLE + " ADD COLUMN " + column.getKey() + " " + column.getValue());
            log.info("mboo_chat_memory 补充列 {} 完成", column.getKey());
        }
    }
}
