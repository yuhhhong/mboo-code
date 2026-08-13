package com.yu.mboocode.agent.service;

import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson2.JSON;
import com.yu.mboocode.agent.dto.ActiveTurnRuntime;
import com.yu.mboocode.agent.dto.ActiveTurnRuntime.TurnTerminalState;
import com.yu.mboocode.agent.enums.TurnOperationType;
import com.yu.mboocode.agent.model.ContextUsageSnapshot;
import com.yu.mboocode.agent.model.ModelInfo;
import com.yu.mboocode.agent.model.payload.*;
import com.yu.mboocode.common.exception.ServiceException;
import com.yu.mboocode.llm.AiCodeService;
import com.yu.mboocode.agent.base.TurnProcess;
import com.yu.mboocode.agent.enums.SessionEventSource;
import com.yu.mboocode.agent.enums.SessionEventType;
import com.yu.mboocode.agent.model.SessionEvent;
import com.yu.mboocode.agent.model.SessionTurn;
import com.yu.mboocode.agent.model.Sessions;
import com.yu.mboocode.agent.model.ToolResultArtifact;
import com.yu.mboocode.agent.tool.ToolApprovalService;
import com.yu.mboocode.agent.tool.event.ToolEventFormatterRegistry;
import com.yu.mboocode.common.util.DateTimeUtil;
import com.yu.mboocode.agent.tool.permission.PermissionMode;
import com.yu.mboocode.llm.context.ContextManagementService;
import com.yu.mboocode.llm.prompt.SystemPromptService;
import com.yu.mboocode.llm.prompt.SystemPromptSnapshot;
import com.yu.mboocode.llm.service.ChatMemoryService;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.memory.chat.ChatMemoryProvider;
import dev.langchain4j.model.chat.request.ChatRequestParameters;
import dev.langchain4j.model.chat.response.StreamingHandle;
import dev.langchain4j.service.tool.ToolExecution;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

@Service
@Slf4j
public class TurnService {
    @Resource
    private AiCodeService aiCodeService;
    @Resource
    private SessionEventStore sessionEventStore;
    @Resource
    private SessionService sessionService;
    @Resource
    private ToolApprovalService toolApprovalService;
    @Resource
    private ChatMemoryProvider chatMemoryProvider;
    @Resource
    private ToolEventFormatterRegistry toolEventFormatterRegistry;
    @Resource
    private ToolResultStore toolResultStore;
    @Resource
    private ModelUsageTracker modelUsageTracker;
    @Resource
    private ModelOptionService modelOptionService;
    @Resource
    private ModelContextPreferenceService modelContextPreferenceService;
    @Resource
    private ContextManagementService contextManagementService;
    @Resource
    private ChatMemoryService chatMemoryService;
    @Resource
    private WorkspaceService workspaceService;
    @Resource
    private SystemPromptService systemPromptService;

    private final Map<String, ActiveTurnRuntime> activeTurnRuntime = new ConcurrentHashMap<>();

    public Flux<@NonNull SessionEvent> turn(String sessionId, String workspacePath, TurnProcess turnProcess) {
        return turn(sessionId, workspacePath, null, TurnOperationType.CHAT, turnProcess);
    }

    public Flux<@NonNull SessionEvent> turn(String sessionId, String workspacePath, PermissionMode permissionMode, TurnProcess turnProcess) {
        return turn(sessionId, workspacePath, permissionMode, TurnOperationType.CHAT, turnProcess);
    }

    public Flux<@NonNull SessionEvent> turn(String sessionId, String workspacePath, TurnOperationType operationType, TurnProcess turnProcess) {
        return turn(sessionId, workspacePath, null, operationType, turnProcess);
    }

    private Flux<@NonNull SessionEvent> turn(String sessionId, String workspacePath, PermissionMode permissionMode, TurnOperationType operationType, TurnProcess turnProcess) {
        ActiveTurnRuntime runtime = startTurn(sessionId, workspacePath, permissionMode, operationType);
        SessionTurn sessionTurn = runtime.getSessionTurn();
        return Flux.defer(() -> {
            if (!runtime.markRunning()) {
                log.warn("忽略已失效 turn 的订阅 sessionId:{} turnId:{}", sessionTurn.sessionId(), sessionTurn.turnId());
                return Flux.empty();
            }
            return Flux.defer(() -> turnProcess.process(sessionTurn))
                    .onErrorResume(error -> {
                        if (!runtime.claimSystemTerminal(TurnTerminalState.ERROR)) {
                            return Flux.empty();
                        }
                        return Flux.just(sessionEventStore.appendSession(
                                sessionTurn.transcriptUri(),
                                sessionTurn.sessionId(),
                                sessionTurn.turnId(),
                                SessionEventType.ERROR,
                                SessionEventSource.SYSTEM,
                                ErrorPayload.builder()
                                        .errorMessage(StrUtil.blankToDefault(error.getMessage(), "未知错误"))
                                        .durationMs(DateTimeUtil.durationMs(sessionTurn.startNano()))
                                        .build()
                        ));
                    })
                    .doOnComplete(() -> runtime.acceptTerminal(TurnTerminalState.COMPLETE))
                    .doOnCancel(() -> {
                        if (!runtime.claimSystemTerminal(TurnTerminalState.CANCEL)) {
                            return;
                        }
                        sessionEventStore.appendSession(
                                sessionTurn.transcriptUri(),
                                sessionTurn.sessionId(),
                                sessionTurn.turnId(),
                                SessionEventType.CANCELLED,
                                SessionEventSource.SYSTEM,
                                CancelledPayload.builder()
                                        .durationMs(DateTimeUtil.durationMs(sessionTurn.startNano()))
                                        .build()
                        );
                    })
                    .doFinally(_ -> finishTurn(runtime));
        });
    }

    private ActiveTurnRuntime startTurn(String sessionId, String workspacePath, PermissionMode permissionMode, TurnOperationType operationType) {
        Sessions session = sessionService.getActiveOrCreateSession(sessionId, workspacePath, permissionMode);
        return workspaceService.withOperationLock(session.getWorkspaceId(), () -> startTurn(session, operationType));
    }

    private ActiveTurnRuntime startTurn(Sessions session, TurnOperationType operationType) {
        String turnId = IdUtil.getSnowflakeNextIdStr();
        SessionTurn sessionTurn = new SessionTurn(session.getId(), session.getTranscriptUri(), session.getWorkspacePath(), turnId,
                System.nanoTime(), operationType);
        ActiveTurnRuntime runtime = new ActiveTurnRuntime(sessionTurn);

        while (true) {
            ActiveTurnRuntime existing = activeTurnRuntime.putIfAbsent(session.getId(), runtime);
            if (existing == null) {
                break;
            }
            if (!existing.tryReclaimStarting()) {
                throw new ServiceException("当前会话已有运行中的 turn");
            }
            if (activeTurnRuntime.remove(session.getId(), existing)) {
                log.warn("清理未订阅的 turn sessionId:{} turnId:{}", session.getId(), existing.getSessionTurn().turnId());
            }
        }

        try {
            Sessions latestSession = sessionService.getActiveSession(session.getId());
            String previousTurnId = latestSession.getActiveTurnId();
            if (!sessionService.claimActiveTurn(session.getId(), previousTurnId, turnId)) {
                throw new ServiceException("当前会话运行状态已发生变化，请重试");
            }
            if (StrUtil.isNotBlank(previousTurnId)) {
                log.warn("识别并接管僵尸 turn sessionId:{} previousTurnId:{} newTurnId:{}", session.getId(), previousTurnId, turnId);
            }
            return runtime;
        } catch (RuntimeException e) {
            activeTurnRuntime.remove(session.getId(), runtime);
            throw e;
        }
    }

    public Flux<@NonNull SessionEvent> chatStream(SessionTurn sessionTurn, String userMessage, ChatRequestParameters params) {
        ActiveTurnRuntime runtime = getActiveRuntime(sessionTurn);
        SystemPromptSnapshot systemPromptSnapshot = systemPromptService.capture(sessionTurn.sessionId(), sessionTurn.workspacePath());
        ModelInfo currentModel = modelOptionService.requireModelInfo(params.modelName());
        long currentContextLimit = modelContextPreferenceService.getEffectiveContextLimit(currentModel);
        // 自动压缩和硬预算检查必须在写入 USER_MESSAGE 前完成；压缩失败时只推送压缩事件并正常结束
        ContextManagementService.ChatPreparation preparation = contextManagementService.prepareChatTurn(sessionTurn, params.modelName(),
                currentContextLimit, userMessage, systemPromptSnapshot);
        Flux<@NonNull SessionEvent> preludeFlux = Flux.fromIterable(preparation.events());
        if (!preparation.proceed()) {
            return preludeFlux;
        }
        String userMessageId = IdUtil.getSnowflakeNextIdStr();
        Flux<@NonNull SessionEvent> userMessageFlux = Flux.just(sessionEventStore.appendSession(
                sessionTurn.transcriptUri(),
                sessionTurn.sessionId(),
                sessionTurn.turnId(),
                SessionEventType.USER_MESSAGE,
                SessionEventSource.USER,
                UserMessagePayload.builder()
                        .messageId(userMessageId)
                        .text(userMessage)
                        .modelName(params.modelName())
                        .build()
        ));

        String assistantMessageId = IdUtil.getSnowflakeNextIdStr();
        StringBuffer finalText = new StringBuffer();
        Flux<@NonNull SessionEvent> assistantMessageFlux = Flux.create(sink -> {
            runtime.configureModelUsage(params.modelName(), currentContextLimit, assistantMessageId, usage -> emitEvent(sink, () -> SessionEvent.builder()
                    .eventId(IdUtil.getSnowflakeNextIdStr())
                    .sessionId(sessionTurn.sessionId())
                    .turnId(sessionTurn.turnId())
                    .type(SessionEventType.CONTEXT_USAGE_UPDATED)
                    .source(SessionEventSource.SYSTEM)
                    .createdAt(DateTimeUtil.now())
                    .payload(ContextUsageUpdatedPayload.builder()
                            .messageId(assistantMessageId)
                            .modelId(usage.modelId())
                            .inputTokens(usage.inputTokens())
                            .outputTokens(usage.outputTokens())
                            .totalTokens(usage.totalTokens())
                            .build())
                    .meta(Collections.emptyMap())
                    .build()));
            modelUsageTracker.register(runtime);
            // 注册流取消处理器
            sink.onCancel(() -> {
                runtime.cancelStreaming();
                toolApprovalService.cancelTurn(sessionTurn.sessionId(), sessionTurn.turnId());
                if (!runtime.claimAssistantTerminal(TurnTerminalState.CANCEL)) {
                    return;
                }

                String text = finalText.toString();
                if (StrUtil.isNotBlank(text)) {
                    sessionEventStore.appendSession(sessionTurn.transcriptUri(), SessionEvent.builder()
                            .eventId(IdUtil.getSnowflakeNextIdStr())
                            .sessionId(sessionTurn.sessionId())
                            .turnId(sessionTurn.turnId())
                            .type(SessionEventType.ASSISTANT_MESSAGE)
                            .source(SessionEventSource.ASSISTANT)
                            .createdAt(DateTimeUtil.now())
                            .payload(AssistantMessagePayload.builder()
                                    .messageId(assistantMessageId)
                                    .state(AssistantMessagePayload.AssistantMessageState.CANCEL)
                                    .text(text)
                                    .durationMs(DateTimeUtil.durationMs(sessionTurn.startNano()))
                                    .contextUsage(runtime.getLatestContextUsage())
                                    .build())
                            .meta(Collections.emptyMap())
                            .build());
                    appendInterruptedMemory(sessionTurn.sessionId(), text);
                }
            });

            aiCodeService.chatStream(sessionTurn.sessionId(), userMessage, systemPromptSnapshot.runtimeEnvironment(), systemPromptSnapshot.workspaceInstructions(), params)
                    .onPartialResponseWithContext((response, context) -> { // 助手回复
                        if (cancelHandle(sink, context.streamingHandle(), runtime)) {
                            return;
                        }

                        String text = response.text();
                        emitEvent(sink, () -> SessionEvent.builder()
                                .eventId(IdUtil.getSnowflakeNextIdStr())
                                .sessionId(sessionTurn.sessionId())
                                .turnId(sessionTurn.turnId())
                                .type(SessionEventType.ASSISTANT_MESSAGE_DELTA)
                                .source(SessionEventSource.ASSISTANT)
                                .createdAt(DateTimeUtil.now())
                                .payload(AssistantMessageDeltaPayload.builder().messageId(assistantMessageId).text(text).build())
                                .meta(Collections.emptyMap())
                                .build());
                        finalText.append(text);
                    })
                    .onPartialThinkingWithContext((thinking, context) -> { // 思考
//                        if (cancelHandle(sink, context.streamingHandle(), runtime)) {
//                            return;
//                        }
                    })
                    .onPartialToolCallWithContext((toolCall, context) -> cancelHandle(sink, context.streamingHandle(), runtime)) // tool call
                    .beforeToolExecution(beforeToolExecution -> { // 工具调用前
                        ToolExecutionRequest request = beforeToolExecution.request();
                        Runnable toolStartedEmitter = () -> emitEvent(sink, () -> sessionEventStore.appendSession(
                                sessionTurn.transcriptUri(),
                                sessionTurn.sessionId(),
                                sessionTurn.turnId(),
                                SessionEventType.TOOL_CALL_STARTED,
                                SessionEventSource.ASSISTANT,
                                ToolCallStartedPayload.builder()
                                        .messageId(assistantMessageId)
                                        .toolCallId(request.id())
                                        .toolName(request.name())
                                        .arguments(toolEventFormatterRegistry.formatArguments(request.name(), request.arguments()))
                                        .build()
                        ));
                        ToolApprovalService.ApprovalRequestStatus approvalStatus = toolApprovalService.requestIfNeeded(sessionTurn, assistantMessageId, request, sink::next, toolStartedEmitter);
                        if (approvalStatus == ToolApprovalService.ApprovalRequestStatus.ALLOWED) {
                            toolStartedEmitter.run();
                        }
                    })
                    .onToolExecuted(toolExecution -> {
                        ToolExecutionRequest request = toolExecution.request();
                        boolean failed = toolExecution.hasFailed();
                        String resultText = toolResultText(toolExecution);
                        ToolEventFormatterRegistry.EndedFormat endedFormat = toolEventFormatterRegistry.formatEnded(request.name(), resultText, failed);
                        ToolCallEndedPayload.ToolCallStatus status = failed ? ToolCallEndedPayload.ToolCallStatus.FAILED : ToolCallEndedPayload.ToolCallStatus.COMPLETED;
                        ToolResultArtifact artifact = toolResultStore.saveResult(sessionTurn.transcriptUri(), sessionTurn.sessionId(), sessionTurn.turnId(),
                                assistantMessageId, request.id(), request.name(), status, resultText, endedFormat.resultPreview());
                        ToolCallEndedPayload payload = ToolCallEndedPayload.builder()
                                .messageId(assistantMessageId)
                                .toolCallId(request.id())
                                .toolName(request.name())
                                .arguments(toolEventFormatterRegistry.formatArguments(request.name(), request.arguments()))
                                .status(status)
                                .resultId(artifact.getResultId())
                                .resultSizeBytes(artifact.getResultSizeBytes())
                                .rawOutputAvailable(artifact.getRawOutputAvailable())
                                .errorCode(failed ? StrUtil.blankToDefault(endedFormat.errorCode(), "TOOL_EXECUTION_FAILED") : null)
                                .errorMessage(failed ? StrUtil.blankToDefault(endedFormat.errorMessage(), endedFormat.resultPreview()) : null)
                                .durationMs(toolExecution.duration().toMillis())
                                .build();

                        emitEvent(sink, () -> sessionEventStore.appendSession(
                                sessionTurn.transcriptUri(),
                                sessionTurn.sessionId(),
                                sessionTurn.turnId(),
                                SessionEventType.TOOL_CALL_ENDED,
                                SessionEventSource.SYSTEM,
                                payload
                        ));
                    })
                    .onCompleteResponse(chatResponse -> {
                        if (!runtime.claimAssistantTerminal(TurnTerminalState.COMPLETE)) {
                            return;
                        }
                        //todo chatResponse.aiMessage() 其他内容处理 机制确认
                        emitEvent(sink, () -> sessionEventStore.appendSession(sessionTurn.transcriptUri(), SessionEvent.builder()
                                .eventId(IdUtil.getSnowflakeNextIdStr())
                                .sessionId(sessionTurn.sessionId())
                                .turnId(sessionTurn.turnId())
                                .type(SessionEventType.ASSISTANT_MESSAGE)
                                .source(SessionEventSource.ASSISTANT)
                                .createdAt(DateTimeUtil.now())
                                .payload(AssistantMessagePayload.builder()
                                        .messageId(assistantMessageId)
                                        .state(AssistantMessagePayload.AssistantMessageState.COMPLETE)
                                        .text(chatResponse.aiMessage().text())
                                        .durationMs(DateTimeUtil.durationMs(sessionTurn.startNano()))
                                        .contextUsage(runtime.getLatestContextUsage())
                                        .build())
                                .meta(Collections.emptyMap())
                                .build()));
                        sink.complete();
                    })
                    .onError(error -> {
                        if (!runtime.claimAssistantTerminal(TurnTerminalState.ERROR)) {
                            return;
                        }
                        String text = finalText.toString();
                        if (StrUtil.isNotBlank(text)) {
                            emitEvent(sink, () -> sessionEventStore.appendSession(sessionTurn.transcriptUri(), SessionEvent.builder()
                                    .eventId(IdUtil.getSnowflakeNextIdStr())
                                    .sessionId(sessionTurn.sessionId())
                                    .turnId(sessionTurn.turnId())
                                    .type(SessionEventType.ASSISTANT_MESSAGE)
                                    .source(SessionEventSource.ASSISTANT)
                                    .createdAt(DateTimeUtil.now())
                                    .payload(AssistantMessagePayload.builder()
                                            .messageId(assistantMessageId)
                                            .state(AssistantMessagePayload.AssistantMessageState.ERROR)
                                            .text(text)
                                            .errorMessage(error.getMessage())
                                            .durationMs(DateTimeUtil.durationMs(sessionTurn.startNano()))
                                            .contextUsage(runtime.getLatestContextUsage())
                                            .build())
                                    .meta(Collections.emptyMap())
                                    .build()));
                            appendInterruptedMemory(sessionTurn.sessionId(), text);
                        }
                        sink.error(error);
                    })
                    .start();
        }, FluxSink.OverflowStrategy.BUFFER);
        return preludeFlux.concatWith(userMessageFlux).concatWith(assistantMessageFlux);
    }

    private boolean cancelHandle(FluxSink<@NonNull SessionEvent> sink, StreamingHandle streamingHandle, ActiveTurnRuntime runtime) {
        runtime.setStreamingHandle(streamingHandle);
        if (sink.isCancelled()) {
            runtime.acceptTerminal(TurnTerminalState.CANCEL);
            streamingHandle.cancel();
            return true;
        }
        return false;
    }

    private ActiveTurnRuntime getActiveRuntime(SessionTurn sessionTurn) {
        ActiveTurnRuntime runtime = activeTurnRuntime.get(sessionTurn.sessionId());
        if (runtime == null || !runtime.getSessionTurn().turnId().equals(sessionTurn.turnId())) {
            throw new ServiceException("当前 turn 运行状态已失效");
        }
        return runtime;
    }

    private void finishTurn(ActiveTurnRuntime runtime) {
        SessionTurn sessionTurn = runtime.getSessionTurn();
        modelUsageTracker.unregister(runtime);
        try {
            toolApprovalService.cancelTurn(sessionTurn.sessionId(), sessionTurn.turnId());
        } catch (Exception e) {
            log.error("清理 turn 授权请求失败 sessionId:{} turnId:{}", sessionTurn.sessionId(), sessionTurn.turnId(), e);
        }
        if (sessionTurn.operationType() == TurnOperationType.CHAT) {
            // 持久化本轮最后一次有效主模型 usage，供下一轮工具压薄、自动摘要和摘要模型选择
            persistLastUsage(runtime);
        }
        try {
            sessionService.clearActiveTurn(sessionTurn.sessionId(), sessionTurn.turnId());
        } catch (Exception e) {
            log.error("清理数据库活跃 turn 失败 sessionId:{} turnId:{}", sessionTurn.sessionId(), sessionTurn.turnId(), e);
        } finally {
            runtime.finish();
            activeTurnRuntime.remove(sessionTurn.sessionId(), runtime);
        }
    }

    private void persistLastUsage(ActiveTurnRuntime runtime) {
        try {
            ContextUsageSnapshot usage = runtime.getLatestContextUsage();
            if (usage == null || usage.totalTokens() == null || usage.totalTokens() <= 0) {
                return;
            }
            chatMemoryService.saveLastUsage(runtime.getSessionTurn().sessionId(), usage.modelId(), JSON.toJSONString(usage), runtime.getContextLimit());
        } catch (Exception e) {
            log.error("持久化上下文用量失败 sessionId:{} turnId:{}", runtime.getSessionTurn().sessionId(), runtime.getSessionTurn().turnId(), e);
        }
    }

    private void appendInterruptedMemory(String sessionId, String text) {
        if (StrUtil.isBlank(text)) {
            return;
        }

        try {
            ChatMemory chatMemory = chatMemoryProvider.get(sessionId);
            List<ChatMessage> messages = chatMemory.messages();
            // 完整响应可能已经由 LangChain4j 先写入，最后一条是 AI 消息时不再重复追加部分响应。
            if (!messages.isEmpty() && messages.getLast() instanceof AiMessage) {
                return;
            }
            chatMemory.add(AiMessage.from(text));
        } catch (RuntimeException e) {
            // JSONL 是事实来源，派生记忆写入失败不能阻止错误或取消事件落盘。
            log.warn("写入中断会话记忆失败，sessionId: {}", sessionId, e);
        }
    }

    private void emitEvent(FluxSink<@NonNull SessionEvent> sink, Supplier<SessionEvent> s) {
        if (!sink.isCancelled()) {
            sink.next(s.get());
        }
    }

    private String toolResultText(ToolExecution toolExecution) {
        try {
            Object resultObject = toolExecution.resultObject();
            if (resultObject instanceof CharSequence text) {
                return text.toString();
            }
            if (resultObject != null) {
                return JSON.toJSONString(resultObject);
            }
        } catch (RuntimeException ignored) {
            // 部分工具只提供文本结果，继续尝试读取 result()。
        }

        try {
            return toolExecution.result();
        } catch (RuntimeException e) {
            return "";
        }
    }

}
