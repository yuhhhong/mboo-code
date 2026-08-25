package com.yu.mboocode.agent.service;

import cn.hutool.core.thread.lock.LockUtil;
import cn.hutool.core.thread.lock.SegmentLock;
import cn.hutool.core.util.IdUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONException;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.common.exception.ServiceException;
import com.yu.mboocode.agent.enums.SessionEventSource;
import com.yu.mboocode.agent.enums.SessionEventType;
import com.yu.mboocode.agent.model.SessionEvent;
import com.yu.mboocode.agent.model.payload.SessionEventPayload;
import com.yu.mboocode.common.util.AppDataPaths;
import com.yu.mboocode.common.util.DateTimeUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.Lock;

/**
 * 负责会话 JSONL 事件日志的追加写入和顺序回放。
 */
@Component
@Slf4j
public class SessionEventStore {
    /**
     * 为新会话生成相对于应用数据目录的主事件日志路径。
     */
    public String newTranscriptUri(String sessionId) {
        return "sessions" + "/" + sessionId + "/session.jsonl";
    }

    /**
     * 将数据库中保存的 transcriptUri 解析成实际文件路径。
     */
    public Path resolveTranscriptPath(String transcriptUri) {
        Path path = Path.of(transcriptUri);
        if (path.isAbsolute()) { //判断是绝对路径，直接返回
            return path;
        }
        return AppDataPaths.root().resolve(path).normalize();
    }

    private final SegmentLock<Lock> fileLocks = LockUtil.createLazySegmentLock(64); // 64 段够本地单机；会话多可调到 128/256

    /**
     * 追加一条完整事件
     */
    /**
     * 按 eventId 幂等追加一条完整事件；JSONL 已存在相同 eventId 时直接返回，不重复写入。
     */
    public SessionEvent appendSessionIdempotent(String transcriptUri, SessionEvent sessionEvent) {
        Lock lock = fileLocks.get(transcriptUri);
        lock.lock();
        try {
            if (containsEventIdLocked(transcriptUri, sessionEvent.getEventId())) {
                return sessionEvent;
            }
        } finally {
            lock.unlock();
        }
        return appendSession(transcriptUri, sessionEvent);
    }

    /**
     * 判断 JSONL 中是否已存在指定 eventId 的事件。
     */
    public boolean containsEventId(String transcriptUri, String eventId) {
        Lock lock = fileLocks.get(transcriptUri);
        lock.lock();
        try {
            return containsEventIdLocked(transcriptUri, eventId);
        } finally {
            lock.unlock();
        }
    }

    private boolean containsEventIdLocked(String transcriptUri, String eventId) {
        if (eventId == null || eventId.isBlank()) {
            return false;
        }
        Path path = resolveTranscriptPath(transcriptUri);
        if (Files.notExists(path)) {
            return false;
        }
        try {
            for (String line : Files.readAllLines(path, StandardCharsets.UTF_8)) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    if (eventId.equals(JSON.parseObject(line).getString("eventId"))) {
                        return true;
                    }
                } catch (JSONException ignored) {
                    // 损坏行无法提供 eventId，跳过即可；写入路径另有修复逻辑
                }
            }
            return false;
        } catch (IOException e) {
            log.error("读取会话事件失败 path:{}", path, e);
            throw new ServiceException("读取会话失败");
        }
    }

    /**
     * 追加一条完整事件
     */
    public SessionEvent appendSession(String transcriptUri, SessionEvent sessionEvent) {
        if (!sessionEvent.getType().isPersistent()) throw new IllegalArgumentException("运行时事件不能写入 JSONL: " + sessionEvent.getType());
        Lock lock = fileLocks.get(transcriptUri);
        lock.lock();
        try {
            Path path = resolveTranscriptPath(transcriptUri);
            Files.createDirectories(path.getParent());
            repairJsonlLastLine(path);
            sessionEvent.getType().validatePayload(sessionEvent.getPayload());
            try (BufferedWriter writer = Files.newBufferedWriter(path, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                writer.write(JSON.toJSONString(sessionEvent));
                writer.newLine();
            }
            return sessionEvent;
        } catch (IOException e) {
            log.error("写入会话事件失败 transcriptUri:{}", transcriptUri, e);
            throw new ServiceException("写入会话事件失败");
        } finally {
            lock.unlock();
        }
    }

    /**
     * 追加一条完整事件
     */
    public SessionEvent appendSession(String transcriptUri, String sessionId, String turnId, SessionEventType type, SessionEventSource source, SessionEventPayload payload) {
        return appendSession(transcriptUri, SessionEvent.builder()
                .eventId(IdUtil.getSnowflakeNextIdStr())
                .sessionId(sessionId)
                .turnId(turnId)
                .type(type)
                .source(source)
                .createdAt(DateTimeUtil.now())
                .payload(payload)
                .meta(Collections.emptyMap())
                .build());
    }

    /**
     * 按文件行顺序读取事件
     */
    public List<SessionEvent> readSession(String transcriptUri) {
        Path path = resolveTranscriptPath(transcriptUri);
        if (Files.notExists(path)) {
            return Collections.emptyList();
        }

        List<SessionEvent> events = new ArrayList<>();
        try {
            List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
            for (int i = 0; i < lines.size(); i++) {
                String line = lines.get(i);
                if (line.isBlank()) {
                    continue;
                }
                try {
                    events.add(parseEventLine(line));
                } catch (JSONException e) {
                    if (i == lines.size() - 1) { //最后一行错误不处理，后续写入会处理掉
                        break;
                    }
                    throw e;
                }
            }
            return events;
        } catch (IOException e) {
            log.error("读取会话事件失败 path:{}", path, e);
            throw new ServiceException("读取会话失败");
        } catch (JSONException e) {
            log.error("读取会话事件失败 path:{}", path, e);
            throw new ServiceException("会话 JSON 格式错误");
        }
    }

    /**
     * 永久删除会话主 JSONL 文件，并尝试清理空的会话目录。
     */
    public void deleteTranscript(String transcriptUri) {
        Path path = resolveTranscriptPath(transcriptUri);
        try {
            Files.deleteIfExists(path);
            Path parent = path.getParent();
            if (parent != null && Files.exists(parent)) {
                try (var children = Files.list(parent)) {
                    if (children.findAny().isEmpty()) {
                        Files.deleteIfExists(parent);
                    }
                }
            }
        } catch (IOException e) {
            log.error("删除会话事件文件失败 path:{}", path, e);
            throw new ServiceException("删除会话事件文件失败");
        }
    }

    /**
     * 先读取事件类型，再用类型绑定的 payload 类反序列化事件主体。
     */
    public SessionEvent parseEvent(String line) {
        return parseEventLine(line);
    }

    @SuppressWarnings("unchecked")
    private SessionEvent parseEventLine(String line) {
        JSONObject json = JSON.parseObject(line);
        String typeName = json.getString("type");
        if (typeName == null) {
            throw new JSONException("事件类型不能为空");
        }

        SessionEventType type;
        try {
            type = SessionEventType.valueOf(typeName);
        } catch (IllegalArgumentException e) {
            throw new JSONException("未知事件类型: " + typeName);
        }

        SessionEventSource source;
        try {
            source = SessionEventSource.valueOf(json.getString("source"));
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new JSONException("未知事件来源: " + json.getString("source"));
        }

        JSONObject payloadJson = json.getJSONObject("payload");
        SessionEventPayload payload = payloadJson == null
                ? JSON.parseObject("{}", type.getPayloadClass())
                : payloadJson.toJavaObject(type.getPayloadClass());
        try {
            type.validatePayload(payload);
        } catch (IllegalArgumentException e) {
            throw new JSONException(e.getMessage());
        }

        Map<String, Object> meta = json.getObject("meta", Map.class);
        return SessionEvent.builder()
                .eventId(json.getString("eventId"))
                .sessionId(json.getString("sessionId"))
                .turnId(json.getString("turnId"))
                .type(type)
                .source(source)
                .createdAt(json.getString("createdAt"))
                .payload(payload)
                .meta(meta == null ? Collections.emptyMap() : meta)
                .build();
    }

    // 修复 JSONL 日志文件最后一行可能的损坏
    private void repairJsonlLastLine(Path path) throws IOException {
        if (Files.notExists(path)) {
            return;
        }

        List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
        if (lines.isEmpty()) {
            return;
        }

        String lastLine = lines.getLast();
        if (lastLine.isBlank()) {
            return;
        }

        try {
            parseEventLine(lastLine);
        } catch (JSONException e) {
            List<String> validLines = lines.subList(0, lines.size() - 1);
            Files.write(path, validLines, StandardCharsets.UTF_8);
        }
    }
}
