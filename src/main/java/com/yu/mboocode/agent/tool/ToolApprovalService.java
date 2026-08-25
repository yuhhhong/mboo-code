package com.yu.mboocode.agent.tool;

import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.StrUtil;
import com.yu.mboocode.agent.enums.SessionEventSource;
import com.yu.mboocode.agent.enums.SessionEventType;
import com.yu.mboocode.agent.enums.ToolApprovalDecision;
import com.yu.mboocode.agent.model.SessionEvent;
import com.yu.mboocode.agent.model.SessionTurn;
import com.yu.mboocode.agent.model.payload.ToolApprovalRequiredPayload;
import com.yu.mboocode.agent.service.McpServerRuntime;
import com.yu.mboocode.agent.skill.SkillRuntime;
import com.yu.mboocode.agent.service.SessionEventStore;
import com.yu.mboocode.agent.service.SessionService;
import com.yu.mboocode.common.exception.ServiceException;
import com.yu.mboocode.agent.tool.command.RunningCommandRegistry;
import com.yu.mboocode.agent.tool.event.ToolEventFormatterRegistry;
import com.yu.mboocode.agent.tool.network.NetworkToolErrorCode;
import com.yu.mboocode.agent.tool.network.RunningNetworkCallRegistry;
import com.yu.mboocode.agent.tool.permission.PermissionCheck;
import com.yu.mboocode.agent.tool.permission.PermissionMode;
import com.yu.mboocode.agent.tool.permission.PermissionRequirement;
import com.yu.mboocode.agent.tool.permission.ToolAuthorizationResult;
import com.yu.mboocode.agent.tool.permission.ToolPermissionChain;
import com.yu.mboocode.agent.tool.permission.ToolPermissionErrorCode;
import com.yu.mboocode.agent.tool.permission.ToolPermissionEvaluatorRegistry;
import com.yu.mboocode.agent.tool.permission.ToolPermissionRegistry;
import com.yu.mboocode.agent.tool.permission.ToolPermissionSpec;
import com.yu.mboocode.agent.tool.permission.ToolPermissionType;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * 工具权限链服务。一次调用只暴露当前阶段，全部要求满足并复核后才允许真实工具启动。
 */
@Service
public class ToolApprovalService {
    private static final long APPROVAL_TIMEOUT_MINUTES = 10;

    @Resource
    private SessionEventStore sessionEventStore;
    @Resource
    private SessionService sessionService;
    @Resource
    private ToolPermissionRegistry toolPermissionRegistry;
    @Resource
    private ToolPermissionEvaluatorRegistry evaluatorRegistry;
    @Resource
    private ToolRequestValidatorRegistry validatorRegistry;
    @Resource
    private ToolEventFormatterRegistry toolEventFormatterRegistry;
    @Resource
    private RunningCommandRegistry runningCommandRegistry;
    @Resource
    private RunningNetworkCallRegistry runningNetworkCallRegistry;
    @Resource
    private McpServerRuntime mcpServerRuntime;
    @Resource
    private SkillRuntime skillRuntime;
    private final Map<String, PendingApprovalStage> pendingByApprovalId = new ConcurrentHashMap<>();
    private final Map<String, PendingToolInvocation> invocationsByToolCall = new ConcurrentHashMap<>();

    public ApprovalRequestStatus requestIfNeeded(SessionTurn sessionTurn, String messageId, ToolExecutionRequest request,
                                                  Consumer<SessionEvent> eventEmitter, Runnable toolStartedEmitter) {
        if (mcpServerRuntime.isMcpTool(request.name()) || skillRuntime.isSkillTool(request.name())) return ApprovalRequestStatus.ALLOWED;
        String key = toolCallKey(sessionTurn.sessionId(), request.id());
        ToolPermissionChain chain;
        try {
            validatorRegistry.validate(sessionTurn.sessionId(), request);
            chain = evaluate(sessionTurn.sessionId(), request);
        } catch (ToolException | ServiceException e) {
            return ApprovalRequestStatus.INVALID;
        }
        if (chain.hasError()) return ApprovalRequestStatus.INVALID;

        PendingToolInvocation invocation = new PendingToolInvocation(sessionTurn.sessionId(), sessionTurn.turnId(), sessionTurn.transcriptUri(), messageId,
                request, chain, eventEmitter, toolStartedEmitter);
        PendingToolInvocation existing = invocationsByToolCall.putIfAbsent(key, invocation);
        if (existing != null) return existing.chain.needsApproval() ? ApprovalRequestStatus.WAITING : ApprovalRequestStatus.ALLOWED;
        if (!chain.needsApproval()) return ApprovalRequestStatus.ALLOWED;
        int firstIndex = firstApprovalIndex(chain, 0);
        createApproval(invocation, firstIndex);
        return ApprovalRequestStatus.WAITING;
    }

    public ToolAuthorizationResult awaitAuthorization(String sessionId, ToolExecutionRequest request) {
        String key = toolCallKey(sessionId, request.id());
        PendingToolInvocation invocation = invocationsByToolCall.get(key);
        if (invocation == null) return evaluateImmediate(sessionId, request);
        if (!invocation.chain.needsApproval()) return verifyFinalPlan(sessionId, request, invocation);

        PermissionRequirement lastRequirement = null;
        try {
            for (int index = 0; index < invocation.chain.requirements().size(); index++) {
                PermissionRequirement requirement = invocation.chain.requirements().get(index);
                lastRequirement = requirement;
                if (requirement.check().status() == PermissionCheck.CheckStatus.ALLOWED) continue;
                if (requirement.check().status() == PermissionCheck.CheckStatus.ERROR) return error(requirement);

                PendingApprovalStage pending = invocation.currentApproval;
                if (pending == null || pending.requirementIndex() != index) pending = createApproval(invocation, index);
                ToolApprovalDecision decision = pending.future().get(APPROVAL_TIMEOUT_MINUTES, TimeUnit.MINUTES);
                cleanupApproval(pending);
                if (decision == ToolApprovalDecision.DENY || invocation.cancelled.get()) {
                    return ToolAuthorizationResult.denied(requirement.permissionType(), requirement.grantPath());
                }
                invocation.grantedRequirements.add(requirement);
                int nextIndex = firstApprovalIndex(invocation.chain, index + 1);
                if (nextIndex >= 0) createApproval(invocation, nextIndex);
            }

            ToolAuthorizationResult verified = verifyFinalPlan(sessionId, request, invocation);
            if (!verified.allowed()) return verified;
            invocation.toolStartedEmitter.run();
            return ToolAuthorizationResult.allow(ToolApprovalDecision.ALLOW_ONCE,
                    lastRequirement == null ? ToolPermissionType.NONE : lastRequirement.permissionType(),
                    lastRequirement == null ? null : lastRequirement.grantPath());
        } catch (TimeoutException e) {
            PendingApprovalStage pending = invocation.currentApproval;
            return ToolAuthorizationResult.timeout(pending == null ? null : pending.requirement.permissionType(), pending == null ? null : pending.requirement.grantPath());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            PendingApprovalStage pending = invocation.currentApproval;
            return ToolAuthorizationResult.error(ToolPermissionErrorCode.PERMISSION_INTERRUPTED, "工具授权等待被中断",
                    pending == null ? null : pending.requirement.permissionType(), pending == null ? null : pending.requirement.grantPath());
        } catch (Exception e) {
            PendingApprovalStage pending = invocation.currentApproval;
            return ToolAuthorizationResult.error(ToolPermissionErrorCode.PERMISSION_ERROR, "工具授权处理失败",
                    pending == null ? null : pending.requirement.permissionType(), pending == null ? null : pending.requirement.grantPath());
        } finally {
            PendingApprovalStage pending = invocation.currentApproval;
            if (pending != null) cleanupApproval(pending);
        }
    }

    public void resolve(String sessionId, String approvalId, ToolApprovalDecision decision) {
        PendingApprovalStage pending = pendingByApprovalId.get(approvalId);
        if (pending == null || !pending.invocation.sessionId.equals(sessionId)) throw new ServiceException("工具授权请求不存在或已失效");
        if (decision == ToolApprovalDecision.ALLOW_SESSION) persistSessionGrant(sessionId, pending);
        if (!pending.future().complete(decision)) throw new ServiceException("工具授权请求已处理");
    }

    public void cancelTurn(String sessionId, String turnId) {
        runningCommandRegistry.cancelTurn(sessionId, turnId);
        runningNetworkCallRegistry.cancelTurn(sessionId, turnId);
        invocationsByToolCall.values().stream()
                .filter(item -> item.sessionId.equals(sessionId) && item.turnId.equals(turnId))
                .forEach(item -> {
                    item.cancelled.set(true);
                    PendingApprovalStage pending = item.currentApproval;
                    if (pending != null) pending.future().complete(ToolApprovalDecision.DENY);
                });
    }

    public void clearSession(String sessionId) {
        runningCommandRegistry.clearSession(sessionId);
        runningNetworkCallRegistry.clearSession(sessionId);
        invocationsByToolCall.values().stream()
                .filter(item -> item.sessionId.equals(sessionId))
                .forEach(item -> {
                    item.cancelled.set(true);
                    PendingApprovalStage pending = item.currentApproval;
                    if (pending != null) pending.future().complete(ToolApprovalDecision.DENY);
                });
    }

    public String turnId(String sessionId, String toolCallId) {
        PendingToolInvocation invocation = invocationsByToolCall.get(toolCallKey(sessionId, toolCallId));
        return invocation == null ? null : invocation.turnId;
    }

    public String networkOrigin(String sessionId, String toolCallId) {
        PendingToolInvocation invocation = invocationsByToolCall.get(toolCallKey(sessionId, toolCallId));
        if (invocation == null) return null;
        return invocation.chain.requirements().stream()
                .filter(requirement -> requirement.permissionType() == ToolPermissionType.NETWORK)
                .map(PermissionRequirement::grantValue)
                .findFirst()
                .orElse(null);
    }

    public void completeInvocation(String sessionId, String toolCallId) {
        invocationsByToolCall.remove(toolCallKey(sessionId, toolCallId));
    }

    private ToolAuthorizationResult evaluateImmediate(String sessionId, ToolExecutionRequest request) {
        try {
            ToolPermissionChain chain = evaluate(sessionId, request);
            for (PermissionRequirement requirement : chain.requirements()) {
                if (requirement.check().status() == PermissionCheck.CheckStatus.ERROR) return error(requirement);
                if (requirement.check().status() == PermissionCheck.CheckStatus.NEED_ASK) return ToolAuthorizationResult.denied(requirement.permissionType(), requirement.grantPath());
            }
            PermissionRequirement last = chain.requirements().isEmpty() ? null : chain.requirements().getLast();
            return ToolAuthorizationResult.allow(ToolApprovalDecision.ALLOW_SESSION, last == null ? ToolPermissionType.NONE : last.permissionType(), last == null ? null : last.grantPath());
        } catch (ToolException e) {
            throw e;
        } catch (RuntimeException e) {
            return ToolAuthorizationResult.error(ToolPermissionErrorCode.PERMISSION_ERROR, "工具权限评估失败", null, null);
        }
    }

    private ToolAuthorizationResult verifyFinalPlan(String sessionId, ToolExecutionRequest request, PendingToolInvocation invocation) {
        ToolPermissionChain current;
        try {
            current = evaluate(sessionId, request);
        } catch (RuntimeException e) {
            return ToolAuthorizationResult.error(ToolPermissionErrorCode.PERMISSION_REVOKED, "执行前权限复核失败", null, null);
        }
        PermissionRequirement expectedNetwork = invocation.chain.requirements().stream()
                .filter(requirement -> requirement.permissionType() == ToolPermissionType.NETWORK)
                .findFirst()
                .orElse(null);
        PermissionRequirement currentNetwork = current.requirements().stream()
                .filter(requirement -> requirement.permissionType() == ToolPermissionType.NETWORK)
                .findFirst()
                .orElse(null);
        if (expectedNetwork != null && (currentNetwork == null || !expectedNetwork.sameScope(currentNetwork))) {
            return ToolAuthorizationResult.error(NetworkToolErrorCode.NETWORK_TARGET_CHANGED, "执行前网络目标与授权时不一致", ToolPermissionType.NETWORK, null);
        }
        for (PermissionRequirement requirement : current.requirements()) {
            if (requirement.check().status() == PermissionCheck.CheckStatus.ERROR) return error(requirement);
            if (requirement.check().status() == PermissionCheck.CheckStatus.ALLOWED) continue;
            boolean onceGranted = invocation.grantedRequirements.stream().anyMatch(granted -> granted.sameScope(requirement));
            if (!onceGranted) {
                ToolErrorCode code = switch (requirement.permissionType()) {
                    case COMMAND -> ToolPermissionErrorCode.COMMAND_PERMISSION_CHANGED;
                    case NETWORK -> NetworkToolErrorCode.NETWORK_TARGET_CHANGED;
                    default -> ToolPermissionErrorCode.PERMISSION_PATH_CHANGED;
                };
                return ToolAuthorizationResult.error(code, "执行前权限范围与授权时不一致", requirement.permissionType(), requirement.grantPath());
            }
        }
        return ToolAuthorizationResult.allow(ToolApprovalDecision.ALLOW_ONCE, null, null);
    }

    private PendingApprovalStage createApproval(PendingToolInvocation invocation, int index) {
        PermissionRequirement requirement = invocation.chain.requirements().get(index);
        String approvalId = IdUtil.getSnowflakeNextIdStr();
        int approvalIndex = approvalStageIndex(invocation.chain, index);
        int approvalCount = approvalStageCount(invocation.chain);
        PendingApprovalStage pending = new PendingApprovalStage(approvalId, invocation, requirement, approvalIndex, approvalCount, index, new CompletableFuture<>());
        invocation.currentApproval = pending;
        pendingByApprovalId.put(approvalId, pending);
        SessionEvent event = sessionEventStore.appendSession(invocation.transcriptUri,
                invocation.sessionId, invocation.turnId, SessionEventType.TOOL_APPROVAL_REQUIRED, SessionEventSource.SYSTEM,
                ToolApprovalRequiredPayload.builder()
                        .messageId(invocation.messageId)
                        .approvalId(approvalId)
                        .toolCallId(invocation.request.id())
                        .toolName(invocation.request.name())
                        .arguments(toolEventFormatterRegistry.formatArguments(invocation.request.name(), invocation.request.arguments()))
                        .title(buildTitle(requirement, invocation.request.name()))
                        .description(buildDescription(requirement, invocation.request.name()))
                        .permissionType(requirement.permissionType())
                        .grantPath(requirement.grantPath())
                        .grantOrigin(requirement.permissionType() == ToolPermissionType.NETWORK ? requirement.grantValue() : null)
                        .approvalIndex(approvalIndex)
                        .approvalCount(approvalCount)
                        .build());
        invocation.eventEmitter.accept(event);
        return pending;
    }

    private void cleanupApproval(PendingApprovalStage pending) {
        pendingByApprovalId.remove(pending.approvalId(), pending);
    }

    private int firstApprovalIndex(ToolPermissionChain chain, int start) {
        for (int index = start; index < chain.requirements().size(); index++) {
            if (chain.requirements().get(index).check().status() == PermissionCheck.CheckStatus.NEED_ASK) return index;
        }
        return -1;
    }

    private int approvalStageIndex(ToolPermissionChain chain, int requirementIndex) {
        int approvalIndex = 0;
        for (int index = 0; index <= requirementIndex; index++) {
            if (chain.requirements().get(index).check().status() == PermissionCheck.CheckStatus.NEED_ASK) approvalIndex++;
        }
        return approvalIndex;
    }

    private int approvalStageCount(ToolPermissionChain chain) {
        return (int) chain.requirements().stream()
                .filter(item -> item.check().status() == PermissionCheck.CheckStatus.NEED_ASK)
                .count();
    }

    private ToolPermissionChain evaluate(String sessionId, ToolExecutionRequest request) {
        ToolPermissionSpec spec = toolPermissionRegistry.get(request.name());
        ToolPermissionChain chain = evaluatorRegistry.evaluate(sessionId, request, spec);
        return applyPermissionMode(sessionId, chain);
    }

    /**
     * 完全访问模式下 NEED_ASK 自动放行，初评与执行前复核共用；ERROR 与内置命令黑名单等硬错误保持原样。
     */
    private ToolPermissionChain applyPermissionMode(String sessionId, ToolPermissionChain chain) {
        if (!chain.needsApproval() || sessionService.getPermissionMode(sessionId) != PermissionMode.FULL_ACCESS) return chain;
        List<PermissionRequirement> requirements = chain.requirements().stream()
                .map(requirement -> requirement.check().status() == PermissionCheck.CheckStatus.NEED_ASK
                        ? new PermissionRequirement(requirement.permissionType(), requirement.grantPath(), requirement.grantValue(),
                                requirement.title(), requirement.description(), PermissionCheck.allowed())
                        : requirement)
                .toList();
        return new ToolPermissionChain(requirements);
    }

    private void persistSessionGrant(String sessionId, PendingApprovalStage pending) {
        PermissionRequirement requirement = pending.requirement;
        switch (requirement.permissionType()) {
            case TOOL -> sessionService.grantToolPermission(sessionId, pending.invocation.request.name());
            case READ -> sessionService.grantReadPath(sessionId, requirement.grantPath());
            case WRITE -> sessionService.grantWritePath(sessionId, requirement.grantPath());
            case COMMAND -> sessionService.grantCommandPermission(sessionId, requirement.grantValue());
            case NETWORK -> sessionService.grantNetworkOrigin(sessionId, requirement.grantValue());
            case NONE -> {
            }
        }
    }

    private ToolAuthorizationResult error(PermissionRequirement requirement) {
        return ToolAuthorizationResult.error(requirement.check().errorCode(), requirement.check().message(), requirement.permissionType(), requirement.grantPath());
    }

    private String buildTitle(PermissionRequirement requirement, String toolName) {
        if (StrUtil.isNotBlank(requirement.title())) return requirement.title();
        return switch (requirement.permissionType()) {
            case TOOL -> "允许调用工具 " + toolName + "？";
            case READ -> "允许读取目录？";
            case WRITE -> "允许写入目录？";
            case COMMAND -> "允许执行命令？";
            case NETWORK -> "允许访问私有网络来源？";
            case NONE -> "需要授权";
        };
    }

    private String buildDescription(PermissionRequirement requirement, String toolName) {
        if (StrUtil.isNotBlank(requirement.description())) return requirement.description();
        return switch (requirement.permissionType()) {
            case READ -> "将授权读取目录：" + requirement.grantPath() + "（包含其子目录）";
            case WRITE -> "将授权读写目录：" + requirement.grantPath() + "（包含其子目录）";
            case NETWORK -> "将授权访问私有网络来源：" + requirement.grantValue() + "。只包含该协议、主机和端口。";
            default -> "工具 " + toolName + " 需要授权后才能继续。";
        };
    }

    private String toolCallKey(String sessionId, String toolCallId) {
        if (StrUtil.isBlank(toolCallId)) throw new ServiceException("工具调用 ID 不能为空");
        return sessionId + ":" + toolCallId;
    }

    private static final class PendingToolInvocation {
        private final String sessionId;
        private final String turnId;
        private final String transcriptUri;
        private final String messageId;
        private final ToolExecutionRequest request;
        private final ToolPermissionChain chain;
        private final Consumer<SessionEvent> eventEmitter;
        private final Runnable toolStartedEmitter;
        private final List<PermissionRequirement> grantedRequirements = new ArrayList<>();
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private volatile PendingApprovalStage currentApproval;

        private PendingToolInvocation(String sessionId, String turnId, String transcriptUri, String messageId, ToolExecutionRequest request,
                                      ToolPermissionChain chain, Consumer<SessionEvent> eventEmitter, Runnable toolStartedEmitter) {
            this.sessionId = sessionId;
            this.turnId = turnId;
            this.transcriptUri = transcriptUri;
            this.messageId = messageId;
            this.request = request;
            this.chain = chain;
            this.eventEmitter = eventEmitter;
            this.toolStartedEmitter = toolStartedEmitter;
        }
    }

    private record PendingApprovalStage(String approvalId, PendingToolInvocation invocation, PermissionRequirement requirement, int approvalIndex,
                                        int approvalCount, int requirementIndex, CompletableFuture<ToolApprovalDecision> future) {
    }

    public enum ApprovalRequestStatus {
        ALLOWED,
        WAITING,
        INVALID
    }
}
