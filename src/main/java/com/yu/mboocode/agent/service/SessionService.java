package com.yu.mboocode.agent.service;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.thread.lock.LockUtil;
import cn.hutool.core.thread.lock.SegmentLock;
import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.yu.mboocode.agent.mapper.SessionsMapper;
import com.yu.mboocode.agent.model.SessionEvent;
import com.yu.mboocode.agent.model.Sessions;
import com.yu.mboocode.agent.model.Workspace;
import com.yu.mboocode.common.exception.ServiceException;
import com.yu.mboocode.common.util.CommonUtil;
import com.yu.mboocode.common.util.DateTimeUtil;
import com.yu.mboocode.llm.service.PersistentChatMemoryStore;
import com.yu.mboocode.agent.tool.permission.PermissionMode;
import com.yu.mboocode.agent.tool.permission.SessionPermissions;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.locks.Lock;
import java.util.function.Consumer;

@Service
@Slf4j
public class SessionService extends ServiceImpl<SessionsMapper, Sessions> {
    @Resource
    private SessionEventStore sessionEventStore;
    @Resource
    private PersistentChatMemoryStore persistentChatMemoryStore;
    @Resource
    private ToolResultStore toolResultStore;
    @Resource
    private WorkspaceService workspaceService;

    @Transactional
    public Sessions getActiveOrCreateSession(String sessionId, String workspacePath, PermissionMode permissionMode) {
        if (StrUtil.isNotBlank(sessionId)) {
            return getActiveSession(sessionId);
        }
        return createSession(workspacePath, permissionMode);
    }

    @Transactional
    public Sessions createSession(String workspacePath, PermissionMode permissionMode) {
        Sessions session = new Sessions();
        session.setId(IdUtil.getSnowflakeNextIdStr());
        session.setTitle("新会话"); //todo 后续看看用大模型的回答
        session.setStatus(Sessions.StatusEnum.ACTIVE.getCode());
        JSONObject metadata = new JSONObject();
        if (permissionMode != null) {
            metadata.put(PERMISSION_MODE_KEY, permissionMode.getCode());
        }
        session.setMetadataJson(metadata.toJSONString());
        if (StrUtil.isNotBlank(workspacePath)) {
            Workspace workspace = workspaceService.getOrCreate(workspacePath);
            session.setWorkspaceId(workspace.getId());
            session.setWorkspacePath(workspace.getPath());
        } else {
            session.setWorkspacePath(createDefaultWorkspace(session.getId(), LocalDate.now()));
        }
        session.setTranscriptUri(sessionEventStore.newTranscriptUri(session.getId()));
        save(session);
        return session;
    }

    // 根据 id 获取当前活跃的会话
    public Sessions getActiveSession(String sessionId) {
        Sessions session = getSession(sessionId);
        if (Objects.equals(session.getStatus(), Sessions.StatusEnum.ACTIVE.getCode())) {
            return session;
        }
        throw new ServiceException("当前会话不可继续使用");
    }

    public Sessions getSession(String sessionId) {
        if (StrUtil.isBlank(sessionId)) {
            throw new ServiceException("会话 ID 不能为空");
        }
        Sessions session = getById(sessionId);
        if (session == null) {
            throw new ServiceException("会话不存在");
        }
        return session;
    }

    public List<Sessions> listActiveSessions() {
        return lambdaQuery()
                .eq(Sessions::getStatus, Sessions.StatusEnum.ACTIVE.getCode())
                .orderByDesc(Sessions::getUpdatedAt)
                .list();
    }

    public List<Sessions> listArchivedSessions() {
        return lambdaQuery()
                .eq(Sessions::getStatus, Sessions.StatusEnum.ARCHIVED.getCode())
                .orderByDesc(Sessions::getArchivedAt)
                .list();
    }

    public List<SessionEvent> readSessionEvents(String sessionId) {
        Sessions session = getSession(sessionId);
        if (StrUtil.isBlank(session.getTranscriptUri())) {
            return Collections.emptyList();
        }
        return sessionEventStore.readSession(session.getTranscriptUri());
    }

    @Transactional
    public Sessions updateTitle(String sessionId, String title) {
        Sessions session = getActiveSession(sessionId);
        String trimmedTitle = StrUtil.trim(title);
        if (StrUtil.isBlank(trimmedTitle)) {
            throw new ServiceException("会话标题不能为空");
        }
        if (trimmedTitle.length() > 80) {
            throw new ServiceException("会话标题不能超过 80 个字符");
        }

        session.setTitle(trimmedTitle);
        updateById(session);
        return getSession(sessionId);
    }

    @Transactional
    public Sessions archiveSession(String sessionId) {
        Sessions session = getSession(sessionId);
        if (!Objects.equals(session.getStatus(), Sessions.StatusEnum.ACTIVE.getCode())) {
            throw new ServiceException("仅活跃会话可归档");
        }
        if (StrUtil.isNotBlank(session.getActiveTurnId())) {
            throw new ServiceException("正在会话中，不能归档");
        }

        String now = DateTimeUtil.now();
        boolean updated = lambdaUpdate()
                .eq(Sessions::getId, sessionId)
                .eq(Sessions::getStatus, Sessions.StatusEnum.ACTIVE.getCode())
                .isNull(Sessions::getActiveTurnId)
                .set(Sessions::getStatus, Sessions.StatusEnum.ARCHIVED.getCode())
                .set(Sessions::getArchivedAt, now)
                .set(Sessions::getUpdatedAt, now)
                .update();
        if (!updated) {
            Sessions latest = getSession(sessionId);
            if (StrUtil.isNotBlank(latest.getActiveTurnId())) {
                throw new ServiceException("正在会话中，不能归档");
            }
            throw new ServiceException("仅活跃会话可归档");
        }
        return getSession(sessionId);
    }

    @Transactional
    public Sessions unarchiveSession(String sessionId) {
        Sessions session = getSession(sessionId);
        if (!Objects.equals(session.getStatus(), Sessions.StatusEnum.ARCHIVED.getCode())) {
            throw new ServiceException("仅已归档会话可取消归档");
        }

        String now = DateTimeUtil.now();
        boolean updated = lambdaUpdate()
                .eq(Sessions::getId, sessionId)
                .eq(Sessions::getStatus, Sessions.StatusEnum.ARCHIVED.getCode())
                .set(Sessions::getStatus, Sessions.StatusEnum.ACTIVE.getCode())
                .set(Sessions::getArchivedAt, null)
                .set(Sessions::getUpdatedAt, now)
                .update();
        if (!updated) {
            throw new ServiceException("仅已归档会话可取消归档");
        }
        return getSession(sessionId);
    }

    @Transactional
    public void deleteSession(String sessionId) {
        Sessions session = getSession(sessionId);
        if (!Objects.equals(session.getStatus(), Sessions.StatusEnum.ARCHIVED.getCode())) {
            throw new ServiceException("仅已归档会话可删除");
        }

        if (StrUtil.isNotBlank(session.getTranscriptUri())) {
            toolResultStore.deleteResults(session.getTranscriptUri());
            sessionEventStore.deleteTranscript(session.getTranscriptUri());
        }
        persistentChatMemoryStore.deleteMessages(sessionId);
        removeById(sessionId);
    }

    /**
     * 按预期旧值占用活跃 turn；旧值非空时用于原子接管上一进程遗留的僵尸 turn。
     */
    public boolean claimActiveTurn(String sessionId, String expectedTurnId, String newTurnId) {
        var update = lambdaUpdate()
                .eq(Sessions::getId, sessionId)
                .eq(Sessions::getStatus, Sessions.StatusEnum.ACTIVE.getCode());
        if (expectedTurnId == null) {
            update.isNull(Sessions::getActiveTurnId);
        } else {
            update.eq(Sessions::getActiveTurnId, expectedTurnId);
        }
        return update
                .set(Sessions::getActiveTurnId, newTurnId)
                .set(Sessions::getUpdatedAt, DateTimeUtil.now())
                .update();
    }

    // 清理当前活跃轮次
    public void clearActiveTurn(String sessionId, String activeTurnId) {
        lambdaUpdate()
                .eq(Sessions::getId, sessionId)
                .eq(Sessions::getActiveTurnId, activeTurnId)
                .set(Sessions::getActiveTurnId, null)
                .set(Sessions::getUpdatedAt, DateTimeUtil.now())
                .update();
    }

    /**
     * 读取会话权限；工作区默认读权限由 workspacePath 动态派生，不写入 metadataJson。
     */
    public SessionPermissions getSessionPermissions(String sessionId) {
        Sessions session = getSession(sessionId);
        return getSessionPermissions(session);
    }

    /**
     * 读取会话权限；工作区默认读权限由 workspacePath 动态派生，不写入 metadataJson。
     */
    public SessionPermissions getSessionPermissions(Sessions session) {
        return parsePermissions(session.getMetadataJson());
    }

    /**
     * 读取会话权限模式；字段缺失或非法时按默认权限处理，兼容历史会话。
     */
    public PermissionMode getPermissionMode(String sessionId) {
        return getPermissionMode(getSession(sessionId));
    }

    /**
     * 读取会话权限模式；字段缺失或非法时按默认权限处理，兼容历史会话。
     */
    public PermissionMode getPermissionMode(Sessions session) {
        return PermissionMode.fromCode(parseMetadata(session.getMetadataJson()).getString(PERMISSION_MODE_KEY));
    }

    /**
     * 修改会话权限模式；走统一的 metadataJson 更新（分段锁 + CAS 重试）。
     */
    @Transactional
    public Sessions updatePermissionMode(String sessionId, PermissionMode mode) {
        if (mode == null) {
            throw new ServiceException("权限模式不能为空");
        }
        updateMetadataJson(sessionId, meta -> meta.put(PERMISSION_MODE_KEY, mode.getCode()));
        return getSession(sessionId);
    }

    @Transactional
    public void grantToolPermission(String sessionId, String toolName) {
        if (StrUtil.isBlank(toolName)) {
            return;
        }
        updatePermissions(sessionId, permissions -> {
            LinkedHashSet<String> tools = new LinkedHashSet<>(CollUtil.emptyIfNull(permissions.getAllowedTools()));
            tools.add(toolName);
            permissions.setAllowedTools(new ArrayList<>(tools));
        });
    }

    @Transactional
    public void grantReadPath(String sessionId, String path) {
        if (StrUtil.isBlank(path)) {
            return;
        }
        updatePermissions(sessionId, permissions -> {
            LinkedHashSet<String> paths = new LinkedHashSet<>(CollUtil.emptyIfNull(permissions.getReadPaths()));
            paths.add(path);
            permissions.setReadPaths(new ArrayList<>(paths));
        });
    }

    @Transactional
    public void grantWritePath(String sessionId, String path) {
        if (StrUtil.isBlank(path)) {
            return;
        }
        updatePermissions(sessionId, permissions -> {
            LinkedHashSet<String> paths = new LinkedHashSet<>(CollUtil.emptyIfNull(permissions.getReadWritePaths()));
            paths.add(path);
            permissions.setReadWritePaths(new ArrayList<>(paths));
        });
    }

    @Transactional
    public void grantCommandPermission(String sessionId, String fingerprint) {
        if (StrUtil.isBlank(fingerprint)) return;
        updatePermissions(sessionId, permissions -> {
            LinkedHashSet<String> commands = new LinkedHashSet<>(CollUtil.emptyIfNull(permissions.getAllowedCommands()));
            commands.add(fingerprint);
            permissions.setAllowedCommands(new ArrayList<>(commands));
        });
    }

    @Transactional
    public void grantNetworkOrigin(String sessionId, String origin) {
        if (StrUtil.isBlank(origin)) return;
        updatePermissions(sessionId, permissions -> {
            LinkedHashSet<String> origins = new LinkedHashSet<>(CollUtil.emptyIfNull(permissions.getAllowedNetworkOrigins()));
            origins.add(origin);
            permissions.setAllowedNetworkOrigins(new ArrayList<>(origins));
        });
    }

    private static final String PERMISSIONS_KEY = "permissions"; // metadataJson 中权限字段名
    private static final String PERMISSION_MODE_KEY = "permissionMode"; // metadataJson 中权限模式字段名
    /**
     * 修改会话 permissions 节点；底层走统一的 metadataJson 更新（分段锁 + CAS 重试）。
     */
    private void updatePermissions(String sessionId, Consumer<SessionPermissions> mutator) {
        updateMetadataJson(sessionId, meta -> {
            SessionPermissions permissions = parsePermissionsObject(meta.get(PERMISSIONS_KEY));
            mutator.accept(permissions);
            meta.put(PERMISSIONS_KEY, permissions);
        });
    }


    private static final int METADATA_UPDATE_MAX_ATTEMPTS = 3; // metadataJson 更新自旋锁最大重试次数
    private final SegmentLock<Lock> sessionMetaLocks = LockUtil.createLazySegmentLock(64); // 按 sessionId 分段锁，串行化同一会话的 metadataJson 读改写。
    /**
     * 统一更新 metadataJson：按 sessionId 加锁，读最新 → 变更 → 按旧值 CAS 写回，失败则重试。
     */
    private void updateMetadataJson(String sessionId, Consumer<JSONObject> mutator) {
        Lock lock = sessionMetaLocks.get(sessionId);
        lock.lock();
        try {
            for (int attempt = 1; attempt <= METADATA_UPDATE_MAX_ATTEMPTS; attempt++) {
                Sessions session = getSession(sessionId);
                String oldJson = session.getMetadataJson();
                JSONObject meta = parseMetadata(oldJson);
                mutator.accept(meta);
                String nextJson = meta.toJSONString();
                String now = DateTimeUtil.now();

                var update = lambdaUpdate().eq(Sessions::getId, sessionId);
                if (oldJson == null) {
                    update.isNull(Sessions::getMetadataJson);
                } else {
                    update.eq(Sessions::getMetadataJson, oldJson);
                }
                boolean updated = update
                        .set(Sessions::getMetadataJson, nextJson)
                        .set(Sessions::getUpdatedAt, now)
                        .update();
                if (updated) {
                    return;
                }
                log.warn("会话 metadataJson CAS 冲突，准备重试 sessionId:{} attempt:{}", sessionId, attempt);
            }
            throw new ServiceException("更新会话元数据失败");
        } finally {
            lock.unlock();
        }
    }

    private SessionPermissions parsePermissions(String metadataJson) {
        JSONObject meta = parseMetadata(metadataJson);
        return parsePermissionsObject(meta.get(PERMISSIONS_KEY));
    }

    private SessionPermissions parsePermissionsObject(Object raw) {
        if (raw == null) {
            return SessionPermissions.builder().build();
        }
        SessionPermissions permissions = JSON.parseObject(JSON.toJSONString(raw), SessionPermissions.class);
        if (permissions == null) {
            return SessionPermissions.builder().build();
        }
        if (permissions.getAllowedTools() == null) {
            permissions.setAllowedTools(new ArrayList<>());
        }
        if (permissions.getReadPaths() == null) {
            permissions.setReadPaths(new ArrayList<>());
        }
        if (permissions.getReadWritePaths() == null) {
            permissions.setReadWritePaths(new ArrayList<>());
        }
        if (permissions.getAllowedCommands() == null) {
            permissions.setAllowedCommands(new ArrayList<>());
        }
        if (permissions.getAllowedNetworkOrigins() == null) {
            permissions.setAllowedNetworkOrigins(new ArrayList<>());
        }
        return permissions;
    }

    private JSONObject parseMetadata(String metadataJson) {
        if (StrUtil.isBlank(metadataJson)) {
            return new JSONObject();
        }
        try {
            JSONObject meta = JSON.parseObject(metadataJson);
            return meta == null ? new JSONObject() : meta;
        } catch (Exception e) {
            log.warn("会话 metadataJson 解析失败，将使用空对象");
            return new JSONObject();
        }
    }

    private String createDefaultWorkspace(String sessionId, LocalDate date) {
        try {
            Path workspacePath = Path.of(CommonUtil.getAppDataDir(), "workspaces", date.toString(), sessionId).toAbsolutePath().normalize();
            Files.createDirectories(workspacePath);
            return workspacePath.toString();
        } catch (IOException | InvalidPathException e) {
            log.error("创建默认工作区失败 sessionId:{}", sessionId, e);
            throw new ServiceException("创建默认工作区失败");
        }
    }

}
