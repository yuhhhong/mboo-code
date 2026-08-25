package com.yu.mboocode.agent.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.yu.mboocode.agent.model.McpServer;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.McpToolProvider;
import dev.langchain4j.mcp.client.DefaultMcpClient;
import dev.langchain4j.mcp.client.McpClient;
import dev.langchain4j.mcp.client.transport.http.StreamableHttpMcpTransport;
import dev.langchain4j.mcp.client.transport.stdio.StdioMcpTransport;
import dev.langchain4j.service.tool.ToolExecutionResult;
import dev.langchain4j.service.tool.ToolExecutor;
import dev.langchain4j.service.tool.ToolProvider;
import dev.langchain4j.service.tool.ToolProviderRequest;
import dev.langchain4j.service.tool.ToolProviderResult;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** MCP 连接运行态注册表，负责共享连接、turn 快照和动态 ToolProvider。 */
@Service
public class McpServerRuntime {
    private static final int MAX_CONCURRENT_TOOLS = 4;
    private final Object connectionLock = new Object();
    private final Map<String, RuntimeState> states = new ConcurrentHashMap<>();
    private final Map<String, Connection> connections = new HashMap<>();
    private final Map<String, TurnSnapshot> turnSnapshots = new HashMap<>();
    private final Map<String, Semaphore> toolLimitsByServerId = new ConcurrentHashMap<>();
    private final Map<String, Semaphore> toolLimitsByToolName = new ConcurrentHashMap<>();
    private final Map<String, Long> generations = new ConcurrentHashMap<>();
    private final ScheduledExecutorService executor = Executors.newScheduledThreadPool(4, r -> {
        Thread thread = new Thread(r, "mcp-connection");
        thread.setDaemon(true);
        return thread;
    });
    private final ToolProvider toolProvider = this::provideTools;
    private volatile boolean closed;

    public ToolProvider toolProvider() {
        return toolProvider;
    }

    public boolean isMcpTool(String toolName) {
        return toolName != null && toolLimitsByToolName.containsKey(toolName);
    }

    /** 在 turn 启动时固定其可用连接，配置变更不会影响已开始的 turn。 */
    public void captureTurnSnapshot(String sessionId, String turnId) {
        List<Connection> closeCandidates = new ArrayList<>();
        synchronized (connectionLock) {
            TurnSnapshot previous = turnSnapshots.remove(sessionId);
            if (previous != null) releaseSnapshotConnections(previous, closeCandidates);
            List<Connection> snapshotConnections = List.copyOf(connections.values());
            snapshotConnections.forEach(connection -> connection.references++);
            turnSnapshots.put(sessionId, new TurnSnapshot(turnId, snapshotConnections));
        }
        closeCandidates.forEach(this::closeRetiredConnection);
    }

    public void releaseTurnSnapshot(String sessionId, String turnId) {
        List<Connection> closeCandidates = new ArrayList<>();
        synchronized (connectionLock) {
            TurnSnapshot snapshot = turnSnapshots.get(sessionId);
            if (snapshot == null || !snapshot.turnId().equals(turnId)) return;
            turnSnapshots.remove(sessionId);
            releaseSnapshotConnections(snapshot, closeCandidates);
        }
        closeCandidates.forEach(this::closeRetiredConnection);
    }

    public void refresh(McpServer server) {
        RuntimeState initialState = Boolean.TRUE.equals(server.getEnabled()) ? new RuntimeState("CONNECTING", null, 0) : new RuntimeState("DISABLED", null, 0);
        long generation = generations.compute(server.getId(), (id, current) -> {
            states.put(id, initialState);
            return current == null ? 1L : current + 1;
        });
        retireCurrentConnection(server.getId());
        if (!Boolean.TRUE.equals(server.getEnabled())) return;
        CompletableFuture.runAsync(() -> connect(server, generation), executor);
    }

    public void remove(String id) {
        generations.remove(id);
        retireCurrentConnection(id);
        states.remove(id);
    }

    public RuntimeState state(String id, boolean enabled) {
        if (!enabled) return new RuntimeState("DISABLED", null, 0);
        return states.getOrDefault(id, new RuntimeState("ERROR", "MCP 连接尚未建立", 0));
    }

    @PreDestroy
    public void close() {
        closed = true;
        executor.shutdownNow();
        Set<Connection> allConnections = new LinkedHashSet<>();
        synchronized (connectionLock) {
            allConnections.addAll(connections.values());
            turnSnapshots.values().forEach(snapshot -> allConnections.addAll(snapshot.connections()));
            connections.clear();
            turnSnapshots.clear();
        }
        allConnections.forEach(connection -> closeQuietly(connection.client));
        toolLimitsByServerId.clear();
        toolLimitsByToolName.clear();
        generations.clear();
        states.clear();
    }

    private ToolProviderResult provideTools(ToolProviderRequest request) {
        List<McpClient> clients;
        synchronized (connectionLock) {
            String sessionId = request.chatMemoryId() == null ? null : String.valueOf(request.chatMemoryId());
            TurnSnapshot snapshot = sessionId == null ? null : turnSnapshots.get(sessionId);
            List<Connection> selected = snapshot == null ? List.copyOf(connections.values()) : snapshot.connections();
            clients = selected.stream().map(connection -> connection.client).toList();
        }
        return McpToolProvider.builder().mcpClients(clients).failIfOneServerFails(false).returnToolResultAttributes(true)
                .toolNameMapper((client, specification) -> client.key() + "__" + specification.name())
                .toolWrapper(delegate -> new LimitedToolExecutor(delegate, toolLimitsByToolName)).build().provideTools(request);
    }

    private void connect(McpServer server, long generation) {
        DefaultMcpClient client = null;
        try {
            JSONObject config = JSON.parseObject(server.getMcpJson());
            var transport = buildTransport(config);
            client = DefaultMcpClient.builder().key(server.getName()).clientName("mboo-code").clientVersion("1.0")
                    .transport(transport).initializationTimeout(Duration.ofSeconds(30)).toolExecutionTimeout(Duration.ofSeconds(120))
                    .reconnectInterval(Duration.ofSeconds(5)).autoHealthCheck(true).build();
            List<ToolSpecification> tools = client.listTools();
            if (tools.size() > McpServerService.MAX_TOOLS) throw new IllegalStateException("工具数量超过 " + McpServerService.MAX_TOOLS + " 个");
            Set<String> qualifiedToolNames = qualifiedToolNames(server.getName(), tools);
            if (!isCurrentGeneration(server.getId(), generation)) {
                closeQuietly(client);
                return;
            }

            Connection connection;
            synchronized (connectionLock) {
                if (!isCurrentGeneration(server.getId(), generation)) {
                    closeQuietly(client);
                    return;
                }
                boolean conflict = connections.values().stream().anyMatch(existing -> existing.qualifiedToolNames.stream().anyMatch(qualifiedToolNames::contains));
                if (conflict) throw new IllegalStateException("MCP 工具限定名与其他服务器冲突");
                Semaphore toolLimit = toolLimitsByServerId.computeIfAbsent(server.getId(), ignored -> new Semaphore(MAX_CONCURRENT_TOOLS));
                qualifiedToolNames.forEach(toolName -> toolLimitsByToolName.put(toolName, toolLimit));
                connection = new Connection(server.getId(), client, toolLimit, qualifiedToolNames);
                connections.put(server.getId(), connection);
            }
            if (!updateStateIfCurrent(server.getId(), generation, new RuntimeState("CONNECTED", null, tools.size()))) retireConnection(server.getId(), connection);
        } catch (Exception e) {
            if (client != null) closeQuietly(client);
            if (!updateStateIfCurrent(server.getId(), generation, new RuntimeState("ERROR", sanitizeError(e, server.getMcpJson()), 0))) return;
            executor.schedule(() -> {
                if (!updateStateIfCurrent(server.getId(), generation, new RuntimeState("CONNECTING", null, 0))) return;
                connect(server, generation);
            }, 5, TimeUnit.SECONDS);
        }
    }

    private Set<String> qualifiedToolNames(String serverName, List<ToolSpecification> tools) {
        Set<String> names = new HashSet<>();
        for (ToolSpecification tool : tools) {
            if (tool.name() == null || tool.name().isBlank()) throw new IllegalStateException("MCP 工具名称不能为空");
            if (!names.add(serverName + "__" + tool.name())) throw new IllegalStateException("MCP 服务器包含重复工具名: " + tool.name());
        }
        return Set.copyOf(names);
    }

    private boolean isCurrentGeneration(String serverId, long generation) {
        return !closed && Long.valueOf(generation).equals(generations.get(serverId));
    }

    private boolean updateStateIfCurrent(String serverId, long generation, RuntimeState state) {
        AtomicBoolean updated = new AtomicBoolean();
        generations.computeIfPresent(serverId, (id, current) -> {
            if (!closed && current == generation) {
                states.put(id, state);
                updated.set(true);
            }
            return current;
        });
        return updated.get();
    }

    private dev.langchain4j.mcp.client.transport.McpTransport buildTransport(JSONObject config) {
        if (config.containsKey("command")) {
            ArrayList<String> command = new ArrayList<>();
            command.add(config.getString("command"));
            JSONArray args = config.getJSONArray("args");
            if (args != null) args.forEach(value -> command.add(String.valueOf(value)));
            Map<String, String> env = new HashMap<>();
            JSONObject envObject = config.getJSONObject("env");
            if (envObject != null) envObject.forEach((key, value) -> env.put(key, String.valueOf(value)));
            List<String> effectiveCommand = applyWorkingDirectory(resolveCommand(command), config.getString("cwd"));
            return new ManagedStdioMcpTransport(effectiveCommand, env);
        }
        Map<String, String> headers = new HashMap<>();
        JSONObject headerObject = config.getJSONObject("headers");
        if (headerObject != null) headerObject.forEach((key, value) -> headers.put(key, String.valueOf(value)));
        return StreamableHttpMcpTransport.builder().url(config.getString("url")).customHeaders(headers).timeout(Duration.ofSeconds(120)).build();
    }

    /** Windows 的 npx/npm 通常是 .cmd 文件，Java ProcessBuilder 不会按 PATHEXT 自动补全扩展名。 */
    private List<String> resolveCommand(List<String> command) {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win") || command.isEmpty()) return command;
        String executable = command.getFirst();
        String resolved = resolveWindowsExecutable(executable);
        if (resolved.equals(executable)) return command;
        ArrayList<String> resolvedCommand = new ArrayList<>(command);
        resolvedCommand.set(0, resolved);
        return resolvedCommand;
    }

    private String resolveWindowsExecutable(String executable) {
        Path input = Path.of(executable);
        boolean hasPath = input.getNameCount() > 1 || executable.contains("\\") || executable.contains("/");
        List<String> candidates = new ArrayList<>();
        if (hasPath) {
            candidates.add(executable);
            candidates.add(executable + ".cmd");
            candidates.add(executable + ".bat");
            candidates.add(executable + ".exe");
        } else {
            String path = System.getenv("PATH");
            if (path == null || path.isBlank()) return executable;
            for (String directory : path.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
                if (directory.isBlank()) continue;
                candidates.add(Path.of(directory, executable + ".cmd").toString());
                candidates.add(Path.of(directory, executable + ".bat").toString());
                candidates.add(Path.of(directory, executable + ".exe").toString());
                candidates.add(Path.of(directory, executable + ".com").toString());
                candidates.add(Path.of(directory, executable).toString());
            }
        }
        return candidates.stream().filter(candidate -> Files.isRegularFile(Path.of(candidate))).findFirst().orElse(executable);
    }

    private List<String> applyWorkingDirectory(List<String> command, String cwd) {
        if (cwd == null || cwd.isBlank()) return command;
        if (System.getProperty("os.name", "").toLowerCase().contains("win")) {
            String commandLine = "cd /d " + quoteWindowsCommandArgument(cwd) + " && "
                    + command.stream().map(this::quoteWindowsCommandArgument).reduce((left, right) -> left + " " + right).orElseThrow();
            return List.of("cmd.exe", "/d", "/s", "/v:off", "/c", commandLine);
        }
        List<String> wrapped = new ArrayList<>(List.of("/bin/sh", "-c", "cd -- \"$1\" && shift && exec \"$@\"", "mboo-mcp", cwd));
        wrapped.addAll(command);
        return wrapped;
    }

    private String quoteWindowsCommandArgument(String value) {
        return "\"" + value.replace("%", "%%").replace("\"", "\\\"") + "\"";
    }

    private void retireCurrentConnection(String id) {
        Connection closeCandidate = null;
        synchronized (connectionLock) {
            Connection connection = connections.remove(id);
            if (connection == null) return;
            connection.retired = true;
            if (connection.references == 0) closeCandidate = connection;
        }
        if (closeCandidate != null) closeRetiredConnection(closeCandidate);
    }

    private void retireConnection(String id, Connection connection) {
        Connection closeCandidate = null;
        synchronized (connectionLock) {
            if (!connections.remove(id, connection)) return;
            connection.retired = true;
            if (connection.references == 0) closeCandidate = connection;
        }
        if (closeCandidate != null) closeRetiredConnection(closeCandidate);
    }

    private void releaseSnapshotConnections(TurnSnapshot snapshot, List<Connection> closeCandidates) {
        for (Connection connection : snapshot.connections()) {
            connection.references--;
            if (connection.retired && connection.references == 0) closeCandidates.add(connection);
        }
    }

    private void closeRetiredConnection(Connection connection) {
        closeQuietly(connection.client);
        synchronized (connectionLock) {
            for (String toolName : connection.qualifiedToolNames) {
                boolean toolNameInUse = connections.values().stream().anyMatch(item -> item.qualifiedToolNames.contains(toolName))
                        || turnSnapshots.values().stream().flatMap(snapshot -> snapshot.connections().stream()).anyMatch(item -> item.qualifiedToolNames.contains(toolName));
                if (!toolNameInUse) toolLimitsByToolName.remove(toolName, connection.toolLimit);
            }
            boolean idInUse = connections.values().stream().anyMatch(item -> item.serverId.equals(connection.serverId))
                    || turnSnapshots.values().stream().flatMap(snapshot -> snapshot.connections().stream()).anyMatch(item -> item.serverId.equals(connection.serverId));
            if (!idInUse) toolLimitsByServerId.remove(connection.serverId, connection.toolLimit);
        }
    }

    private void closeQuietly(McpClient client) {
        try {
            client.close();
        } catch (Exception ignored) {
        }
    }

    private String sanitizeError(Exception exception, String configJson) {
        String message = exception.getMessage();
        if (message == null || message.isBlank()) return "MCP 连接失败";
        String sanitized = message.replaceAll("(?i)(authorization\\s*[:=]\\s*|bearer\\s+)[^,\\s]+", "$1[REDACTED]")
                .replaceAll("(?i)(token|api[-_]?key|password|secret)(\\s*[:=]\\s*)[^,\\s]+", "$1$2[REDACTED]");
        JSONObject config = JSON.parseObject(configJson);
        for (String field : new String[]{"env", "headers"}) {
            JSONObject values = config.getJSONObject(field);
            if (values == null) continue;
            for (Object value : values.values()) {
                String secret = String.valueOf(value);
                if (!secret.isBlank()) sanitized = sanitized.replace(secret, "[REDACTED]");
            }
        }
        return sanitized;
    }

    private static final class Connection {
        private final String serverId;
        private final McpClient client;
        private final Semaphore toolLimit;
        private final Set<String> qualifiedToolNames;
        private int references;
        private boolean retired;

        private Connection(String serverId, McpClient client, Semaphore toolLimit, Set<String> qualifiedToolNames) {
            this.serverId = serverId;
            this.client = client;
            this.toolLimit = toolLimit;
            this.qualifiedToolNames = qualifiedToolNames;
        }
    }

    private record TurnSnapshot(String turnId, List<Connection> connections) {
    }

    /** stdio 关闭时同时清理命令派生进程，避免 shell 或包管理器留下子进程。 */
    private static final class ManagedStdioMcpTransport extends StdioMcpTransport {
        private ManagedStdioMcpTransport(List<String> command, Map<String, String> environment) {
            super(StdioMcpTransport.builder().command(command).environment(environment));
        }

        @Override
        public void close() throws IOException {
            Process process = getProcess();
            List<ProcessHandle> descendants = process == null ? List.of() : process.descendants().toList();
            try {
                super.close();
            } finally {
                descendants.forEach(ProcessHandle::destroy);
                descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            }
        }
    }

    private static final class LimitedToolExecutor implements ToolExecutor {
        private final ToolExecutor delegate;
        private final Map<String, Semaphore> limits;

        private LimitedToolExecutor(ToolExecutor delegate, Map<String, Semaphore> limits) {
            this.delegate = delegate;
            this.limits = limits;
        }

        @Override
        public String execute(ToolExecutionRequest request, Object memoryId) {
            Semaphore semaphore = semaphore(request);
            boolean acquired = false;
            try {
                semaphore.acquire();
                acquired = true;
                return delegate.execute(request, memoryId);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("MCP 工具调用被中断", e);
            } finally {
                if (acquired) semaphore.release();
            }
        }

        @Override
        public ToolExecutionResult executeWithContext(ToolExecutionRequest request, dev.langchain4j.invocation.InvocationContext context) {
            Semaphore semaphore = semaphore(request);
            boolean acquired = false;
            try {
                semaphore.acquire();
                acquired = true;
                return delegate.executeWithContext(request, context);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("MCP 工具调用被中断", e);
            } finally {
                if (acquired) semaphore.release();
            }
        }

        private Semaphore semaphore(ToolExecutionRequest request) {
            return limits.computeIfAbsent(request.name() == null ? "" : request.name(), ignored -> new Semaphore(MAX_CONCURRENT_TOOLS));
        }
    }

    public record RuntimeState(String status, String lastError, int toolCount) {
    }
}
