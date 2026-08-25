package com.yu.mboocode.agent.skill;

import cn.hutool.crypto.digest.DigestUtil;
import com.yu.mboocode.agent.model.Workspace;
import com.yu.mboocode.agent.service.WorkspaceService;
import com.yu.mboocode.agent.skill.dto.SkillDetailResp;
import com.yu.mboocode.agent.skill.dto.SkillResourceResp;
import com.yu.mboocode.agent.skill.dto.SkillResp;
import com.yu.mboocode.agent.skill.dto.SkillSuggestResp;
import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillResourceDescriptor;
import com.yu.mboocode.agent.skill.model.SkillScope;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.agent.skill.model.SkillStatus;
import com.yu.mboocode.common.exception.ServiceException;
import dev.langchain4j.skills.ClassPathSkillLoader;
import dev.langchain4j.skills.DefaultSkillResource;
import dev.langchain4j.skills.FileSystemSkillLoader;
import dev.langchain4j.skills.Skill;
import dev.langchain4j.skills.Skills;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Skill 文件系统注册表。每次列表请求和 turn 捕获都重新扫描，文件系统/classpath 始终是唯一事实来源。
 */
@Service
@Slf4j
public class SkillRegistry {
    public static final long MAX_SKILL_MARKDOWN_BYTES = 256L * 1024;
    public static final long MAX_SKILL_TOTAL_BYTES = 4L * 1024 * 1024;
    public static final int MAX_SKILL_FILES = 128;
    private static final Pattern NAME_PATTERN = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final String SKILL_FILE = "SKILL.md";

    @Resource
    private WorkspaceService workspaceService;

    public List<SkillResp> list(String sourceGroup, String currentWorkspaceId) {
        Set<SkillSource> selectedSources = sourcesOf(sourceGroup);
        List<Workspace> workspaces = workspaceService.list().stream().sorted(Comparator.comparing(Workspace::getPath).thenComparing(Workspace::getId)).toList();
        List<SkillDescriptor> globals = new ArrayList<>();
        globals.addAll(scanFileSystemRoot(globalRoot(".mboo"), SkillSource.GLOBAL_MBOO, null, null));
        globals.addAll(scanFileSystemRoot(globalRoot(".agents"), SkillSource.GLOBAL_AGENTS, null, null));
        globals.addAll(scanBuiltin());

        Map<String, List<SkillDescriptor>> projects = new LinkedHashMap<>();
        for (Workspace workspace : workspaces) {
            List<SkillDescriptor> descriptors = scanProject(workspace);
            if (!descriptors.isEmpty()) projects.put(workspace.getId(), descriptors);
        }

        List<SkillResp> responses = new ArrayList<>();
        Map<String, SkillDescriptor> currentEffective = effectiveMap(currentWorkspaceId == null ? List.of() : projects.getOrDefault(currentWorkspaceId, List.of()), globals);
        for (SkillDescriptor descriptor : globals) {
            if (!selectedSources.contains(descriptor.source())) continue;
            responses.add(toResponse(descriptor, currentEffective.get(descriptor.name())));
        }
        for (Map.Entry<String, List<SkillDescriptor>> project : projects.entrySet()) {
            Map<String, SkillDescriptor> effective = effectiveMap(project.getValue(), globals);
            for (SkillDescriptor descriptor : project.getValue()) {
                if (!selectedSources.contains(descriptor.source())) continue;
                responses.add(toResponse(descriptor, effective.get(descriptor.name())));
            }
        }
        responses.sort(Comparator.comparing((SkillResp item) -> item.scope() == SkillScope.PROJECT ? 0 : item.scope() == SkillScope.GLOBAL ? 1 : 2)
                .thenComparing(item -> item.workspaceName() == null ? "" : item.workspaceName(), String.CASE_INSENSITIVE_ORDER)
                .thenComparing(SkillResp::name).thenComparing(item -> item.source().ordinal()));
        return responses;
    }

    public List<SkillDescriptor> effectiveSkills(String workspaceId, String workspacePath) {
        List<SkillDescriptor> globals = new ArrayList<>();
        globals.addAll(scanFileSystemRoot(globalRoot(".mboo"), SkillSource.GLOBAL_MBOO, null, null));
        globals.addAll(scanFileSystemRoot(globalRoot(".agents"), SkillSource.GLOBAL_AGENTS, null, null));
        globals.addAll(scanBuiltin());
        List<SkillDescriptor> projects = new ArrayList<>();
        if (workspacePath != null && !workspacePath.isBlank()) {
            String workspaceName;
            try {
                Path fileName = Path.of(workspacePath).getFileName();
                workspaceName = fileName == null ? workspacePath : fileName.toString();
            } catch (InvalidPathException e) {
                workspaceName = workspacePath;
            }
            projects.addAll(scanFileSystemRoot(Path.of(workspacePath).resolve(".mboo/skills"), SkillSource.PROJECT_MBOO, workspaceId, workspaceName));
            projects.addAll(scanFileSystemRoot(Path.of(workspacePath).resolve(".agents/skills"), SkillSource.PROJECT_AGENTS, workspaceId, workspaceName));
        }
        return effectiveMap(projects, globals).values().stream().sorted(Comparator.comparing(SkillDescriptor::name)).toList();
    }

    public String formatAvailableSkills(List<SkillDescriptor> descriptors) {
        if (descriptors.isEmpty()) return "";
        return Skills.from(descriptors.stream().map(SkillDescriptor::skill).toList()).formatAvailableSkills();
    }

    public SkillDetailResp detail(SkillSource source, String name, String workspaceId, String resourcePath) {
        SkillDescriptor descriptor = requireDescriptor(source, name, workspaceId);
        String skillMarkdown = descriptor.skillMarkdown();
        long contentSize = descriptor.contentSize();
        if (descriptor.status() == SkillStatus.INVALID && descriptor.rootPath() != null) {
            try {
                Path invalidSkillFile = descriptor.rootPath().resolve(SKILL_FILE);
                if (Files.isRegularFile(invalidSkillFile, LinkOption.NOFOLLOW_LINKS)) {
                    long invalidSize = Files.size(invalidSkillFile);
                    if (invalidSize > MAX_SKILL_MARKDOWN_BYTES) throw new IOException("SKILL.md 超过查看上限");
                    String invalidMarkdown = decodeUtf8(Files.readAllBytes(invalidSkillFile), "SKILL.md 不是有效的 UTF-8 文本");
                    if (invalidMarkdown.indexOf('\0') < 0) {
                        skillMarkdown = invalidMarkdown;
                        contentSize = invalidSize;
                    }
                }
            } catch (Exception ignored) {
                // 无效 Skill 只在已确认安全且可读时展示正文，其他情况保持空内容。
            }
        }
        String resourceContent = null;
        String normalizedResource = null;
        if (resourcePath != null && !resourcePath.isBlank()) {
            String requestedResource = normalizeRelativeResource(resourcePath);
            normalizedResource = requestedResource;
            SkillResourceDescriptor resource = descriptor.resources().stream().filter(item -> item.relativePath().equals(requestedResource)).findFirst()
                    .orElseThrow(() -> new ServiceException("Skill 资源不存在"));
            if (resource.textContent() == null) throw new ServiceException("Skill 资源不是有效的 UTF-8 文本");
            if (resource.size() > 64L * 1024) throw new ServiceException("Skill 资源超过 64 KiB 查看上限");
            resourceContent = resource.textContent();
        }
        List<SkillResourceResp> resources = descriptor.resources().stream()
                .map(item -> new SkillResourceResp(item.relativePath(), item.size(), item.script(), item.textContent() != null)).toList();
        return new SkillDetailResp(descriptor.name(), descriptor.description(), descriptor.source(), descriptor.scope(), descriptor.workspaceId(),
                descriptor.workspaceName(), descriptor.status(), descriptor.errorMessage(), skillMarkdown, contentSize,
                descriptor.totalSize(), descriptor.fileCount(), descriptor.contentHash(), resources, normalizedResource, resourceContent);
    }

    public List<SkillSuggestResp> suggest(String query, String workspaceId) {
        Workspace workspace = workspaceId == null || workspaceId.isBlank() ? null : workspaceService.getById(workspaceId);
        String workspacePath = workspace == null ? null : workspace.getPath();
        String normalized = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        return effectiveSkills(workspaceId, workspacePath).stream()
                .filter(item -> normalized.isEmpty() || item.name().contains(normalized) || item.description().toLowerCase(Locale.ROOT).contains(normalized))
                .sorted(Comparator.comparingInt((SkillDescriptor item) -> matchRank(item, normalized)).thenComparing(SkillDescriptor::name))
                .map(item -> new SkillSuggestResp(item.name(), item.description(), item.source())).toList();
    }

    public SkillDescriptor requireDescriptor(SkillSource source, String name, String workspaceId) {
        if (source == null || !isSafeDirectoryName(name)) throw new ServiceException("Skill 请求参数错误");
        List<SkillDescriptor> descriptors;
        if (source.getScope() == SkillScope.PROJECT) {
            Workspace workspace = workspaceService.getById(workspaceId);
            if (workspace == null) throw new ServiceException("工作区不存在");
            descriptors = scanProject(workspace);
        } else if (source == SkillSource.GLOBAL_MBOO) {
            descriptors = scanFileSystemRoot(globalRoot(".mboo"), source, null, null);
        } else if (source == SkillSource.GLOBAL_AGENTS) {
            descriptors = scanFileSystemRoot(globalRoot(".agents"), source, null, null);
        } else {
            descriptors = scanBuiltin();
        }
        return descriptors.stream().filter(item -> item.source() == source && item.name().equals(name)).findFirst()
                .orElseThrow(() -> new ServiceException("Skill 不存在"));
    }

    public SkillDescriptor validateInstalledDirectory(Path directory, SkillSource source, String workspaceId, String workspaceName) {
        return validateDirectory(directory, source, workspaceId, workspaceName, true);
    }

    public SkillDescriptor validateImportDirectory(Path directory, SkillSource source, String workspaceId, String workspaceName) {
        return validateDirectory(directory, source, workspaceId, workspaceName, false);
    }

    private List<SkillDescriptor> scanProject(Workspace workspace) {
        List<SkillDescriptor> descriptors = new ArrayList<>();
        try {
            Path root = Path.of(workspace.getPath());
            String name = root.getFileName() == null ? workspace.getPath() : root.getFileName().toString();
            descriptors.addAll(scanFileSystemRoot(root.resolve(".mboo/skills"), SkillSource.PROJECT_MBOO, workspace.getId(), name));
            descriptors.addAll(scanFileSystemRoot(root.resolve(".agents/skills"), SkillSource.PROJECT_AGENTS, workspace.getId(), name));
        } catch (InvalidPathException e) {
            log.warn("跳过路径无效的工作区 Skill 扫描 workspaceId:{}", workspace.getId());
        }
        return descriptors;
    }

    private List<SkillDescriptor> scanFileSystemRoot(Path sourceRoot, SkillSource source, String workspaceId, String workspaceName) {
        if (!Files.isDirectory(sourceRoot, LinkOption.NOFOLLOW_LINKS)) return List.of();
        List<SkillDescriptor> descriptors = new ArrayList<>();
        try {
            if (Files.isSymbolicLink(sourceRoot)) return List.of();
            Path ownerRoot = sourceRoot.getParent() == null ? null : sourceRoot.getParent().getParent();
            if (ownerRoot == null || !sourceRoot.toRealPath().startsWith(ownerRoot.toRealPath())) {
                log.warn("跳过越过来源边界的 Skill 根目录 source:{} workspaceId:{}", source, workspaceId);
                return List.of();
            }
        } catch (IOException e) {
            log.warn("Skill 来源边界解析失败 source:{} workspaceId:{}", source, workspaceId);
            return List.of();
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(sourceRoot)) {
            for (Path child : stream) {
                if (!Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(child)) continue;
                descriptors.add(validateDirectory(child, source, workspaceId, workspaceName, true));
            }
        } catch (IOException e) {
            log.warn("Skill 来源扫描失败 source:{} workspaceId:{}", source, workspaceId);
            return List.of();
        }
        descriptors.sort(Comparator.comparing(SkillDescriptor::name));
        return descriptors;
    }

    private SkillDescriptor validateDirectory(Path directory, SkillSource source, String workspaceId, String workspaceName, boolean requireDirectoryName) {
        String fallbackName = directory.getFileName() == null ? "invalid" : directory.getFileName().toString();
        Path safeRoot = null;
        try {
            if (Files.isSymbolicLink(directory)) throw new SkillValidationException("Skill 目录不能是符号链接或目录联接");
            Path sourceRoot = directory.getParent().toRealPath();
            Path realRoot = directory.toRealPath();
            if (!realRoot.startsWith(sourceRoot)) throw new SkillValidationException("Skill 目录越过来源边界");
            safeRoot = realRoot;

            Path skillFile = realRoot.resolve(SKILL_FILE);
            if (!Files.isRegularFile(skillFile, LinkOption.NOFOLLOW_LINKS)) throw new SkillValidationException("目录根部缺少 SKILL.md");
            long sameNameCount;
            try (var entries = Files.list(realRoot)) {
                sameNameCount = entries.filter(path -> path.getFileName().toString().equalsIgnoreCase(SKILL_FILE)).count();
            }
            if (sameNameCount != 1) throw new SkillValidationException("目录根部必须且只能包含一个 SKILL.md");

            List<Path> files = new ArrayList<>();
            try (var walk = Files.walk(realRoot)) {
                for (Path path : walk.toList()) {
                    if (path.equals(realRoot)) continue;
                    if (Files.isSymbolicLink(path)) throw new SkillValidationException("Skill 不能包含符号链接或目录联接");
                    Path realPath = path.toRealPath();
                    if (!realPath.startsWith(realRoot)) throw new SkillValidationException("Skill 资源越过目录边界");
                    BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    if (attributes.isDirectory()) continue;
                    if (!attributes.isRegularFile()) throw new SkillValidationException("Skill 包含不支持的文件类型");
                    files.add(path);
                }
            }
            files.sort(Comparator.comparing(path -> normalizeRelative(realRoot.relativize(path))));
            if (files.size() > MAX_SKILL_FILES) throw new SkillValidationException("Skill 文件数量超过 128 个");

            long totalSize = 0;
            for (Path file : files) {
                totalSize += Files.size(file);
                if (totalSize > MAX_SKILL_TOTAL_BYTES) throw new SkillValidationException("Skill 总大小超过 4 MiB");
            }
            long contentSize = Files.size(skillFile);
            if (contentSize > MAX_SKILL_MARKDOWN_BYTES) throw new SkillValidationException("SKILL.md 超过 256 KiB");
            byte[] skillBytes = Files.readAllBytes(skillFile);
            String markdown = decodeUtf8(skillBytes, "SKILL.md 不是有效的 UTF-8 文本");
            ParsedFrontMatter frontMatter = parseFrontMatter(markdown);
            if (requireDirectoryName && !fallbackName.equals(frontMatter.name())) throw new SkillValidationException("Skill 目录名必须与 YAML name 一致");

            List<SkillResourceDescriptor> resources = new ArrayList<>();
            List<DefaultSkillResource> langChainResources = new ArrayList<>();
            for (Path file : files) {
                String relativePath = normalizeRelative(realRoot.relativize(file));
                if (SKILL_FILE.equals(relativePath)) continue;
                byte[] bytes = Files.readAllBytes(file);
                String text = tryDecodeUtf8(bytes);
                boolean script = relativePath.startsWith("scripts/");
                resources.add(new SkillResourceDescriptor(relativePath, bytes.length, script, text));
                if (text != null) langChainResources.add(DefaultSkillResource.builder().relativePath(relativePath).content(text).build());
            }

            // 先调用官方加载器验证与 LangChain4j 标准格式兼容，再用已完成边界校验的不可变资源构建 turn Skill。
            if (!markdown.startsWith("\uFEFF")) {
                Skill loaded = FileSystemSkillLoader.loadSkill(realRoot);
                if (!frontMatter.name().equals(loaded.name()) || !frontMatter.description().equals(loaded.description())) {
                    throw new SkillValidationException("SKILL.md 元数据与标准 Skill 解析结果不一致");
                }
            }
            Skill skill = Skill.builder().name(frontMatter.name()).description(frontMatter.description()).content(frontMatter.content()).resources(langChainResources).build();
            return new SkillDescriptor(frontMatter.name(), frontMatter.description(), skill.content(), markdown, source, source.getScope(), workspaceId,
                    workspaceName, SkillStatus.VALID, null, contentSize, totalSize, files.size(), resources, hashFileTree(realRoot, files), realRoot, skill);
        } catch (SkillValidationException e) {
            return invalidDescriptor(fallbackName, source, workspaceId, workspaceName, e.getMessage(), safeRoot);
        } catch (Exception e) {
            log.debug("Skill 校验失败 source:{} workspaceId:{} name:{}", source, workspaceId, fallbackName);
            return invalidDescriptor(fallbackName, source, workspaceId, workspaceName, "Skill 文件无法安全读取或解析", safeRoot);
        }
    }

    private List<SkillDescriptor> scanBuiltin() {
        try {
            List<SkillDescriptor> result = new ArrayList<>();
            for (Skill skill : ClassPathSkillLoader.loadSkills("skills")) {
                List<SkillResourceDescriptor> resources = skill.resources().stream()
                        .map(item -> new SkillResourceDescriptor(normalizeRelativeResource(item.relativePath()), item.content().getBytes(StandardCharsets.UTF_8).length,
                                normalizeRelativeResource(item.relativePath()).startsWith("scripts/"), item.content())).toList();
                String markdown = "---\nname: " + skill.name() + "\ndescription: " + skill.description() + "\n---\n\n" + skill.content();
                long contentSize = markdown.getBytes(StandardCharsets.UTF_8).length;
                long totalSize = contentSize + resources.stream().mapToLong(SkillResourceDescriptor::size).sum();
                ByteArrayOutputStream hashInput = new ByteArrayOutputStream();
                hashInput.writeBytes(markdown.getBytes(StandardCharsets.UTF_8));
                for (SkillResourceDescriptor resource : resources.stream().sorted(Comparator.comparing(SkillResourceDescriptor::relativePath)).toList()) {
                    hashInput.writeBytes(resource.relativePath().getBytes(StandardCharsets.UTF_8));
                    hashInput.writeBytes(resource.textContent().getBytes(StandardCharsets.UTF_8));
                }
                result.add(new SkillDescriptor(skill.name(), skill.description(), skill.content(), markdown, SkillSource.BUILTIN, SkillScope.BUILTIN,
                        null, null, SkillStatus.VALID, null, contentSize, totalSize, resources.size() + 1, resources,
                        DigestUtil.sha256Hex(hashInput.toByteArray()), null, skill));
            }
            return result.stream().sorted(Comparator.comparing(SkillDescriptor::name)).toList();
        } catch (Exception e) {
            log.debug("classpath 中没有可加载的内置 Skill");
            return List.of();
        }
    }

    private ParsedFrontMatter parseFrontMatter(String markdown) {
        String text = markdown.startsWith("\uFEFF") ? markdown.substring(1) : markdown;
        if (text.indexOf('\0') >= 0) throw new SkillValidationException("SKILL.md 不能包含 NUL");
        String normalized = text.replace("\r\n", "\n").replace('\r', '\n');
        if (!normalized.startsWith("---\n")) throw new SkillValidationException("SKILL.md 缺少 YAML Front Matter");
        int closing = normalized.indexOf("\n---\n", 4);
        int closingLength = 5;
        if (closing < 0 && normalized.endsWith("\n---")) {
            closing = normalized.length() - 4;
            closingLength = 4;
        }
        if (closing < 0) throw new SkillValidationException("SKILL.md 的 YAML Front Matter 未闭合");
        String yamlText = normalized.substring(4, closing);
        String content = normalized.substring(closing + closingLength).strip();
        if (content.isEmpty()) throw new SkillValidationException("Skill 正文不能为空");
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(false);
        options.setMaxAliasesForCollections(0);
        Object value;
        try {
            value = new Yaml(new SafeConstructor(options)).load(yamlText);
        } catch (RuntimeException e) {
            throw new SkillValidationException("SKILL.md 的 YAML Front Matter 格式错误");
        }
        if (!(value instanceof Map<?, ?> map)) throw new SkillValidationException("SKILL.md 的 YAML Front Matter 必须是对象");
        Object nameValue = map.get("name");
        Object descriptionValue = map.get("description");
        if (!(nameValue instanceof String name) || name.isBlank()) throw new SkillValidationException("Skill name 不能为空");
        if (!(descriptionValue instanceof String description) || description.isBlank()) throw new SkillValidationException("Skill description 不能为空");
        if (!NAME_PATTERN.matcher(name).matches()) throw new SkillValidationException("Skill name 只能包含小写字母、数字和连字符");
        return new ParsedFrontMatter(name, description.trim(), content);
    }

    private Map<String, SkillDescriptor> effectiveMap(List<SkillDescriptor> projects, List<SkillDescriptor> globals) {
        List<SkillDescriptor> ordered = new ArrayList<>();
        ordered.addAll(projects);
        ordered.addAll(globals);
        ordered.sort(Comparator.comparingInt(item -> item.source().ordinal()));
        Map<String, SkillDescriptor> effective = new LinkedHashMap<>();
        for (SkillDescriptor descriptor : ordered) {
            if (descriptor.status() == SkillStatus.VALID) effective.putIfAbsent(descriptor.name(), descriptor);
        }
        return effective;
    }

    private SkillResp toResponse(SkillDescriptor descriptor, SkillDescriptor effective) {
        boolean isEffective = effective != null && sameDescriptor(descriptor, effective);
        SkillSource shadowedBy = effective == null || isEffective ? null : effective.source();
        return new SkillResp(descriptor.name(), descriptor.description(), descriptor.source(), descriptor.scope(), descriptor.workspaceId(),
                descriptor.workspaceName(), descriptor.status(), descriptor.errorMessage(), isEffective, shadowedBy, descriptor.contentSize(),
                descriptor.totalSize(), descriptor.fileCount(), descriptor.resourceCount(), descriptor.contentHash(), descriptor.source().isManageable(),
                descriptor.source().isManageable());
    }

    private boolean sameDescriptor(SkillDescriptor left, SkillDescriptor right) {
        return left.source() == right.source() && java.util.Objects.equals(left.workspaceId(), right.workspaceId())
                && java.util.Objects.equals(left.contentHash(), right.contentHash());
    }

    private SkillDescriptor invalidDescriptor(String name, SkillSource source, String workspaceId, String workspaceName, String message, Path safeRoot) {
        return new SkillDescriptor(name, "无效 Skill", "", "", source, source.getScope(), workspaceId, workspaceName, SkillStatus.INVALID,
                message, 0, 0, 0, List.of(), "", safeRoot, null);
    }

    private Set<SkillSource> sourcesOf(String sourceGroup) {
        if ("mboo".equalsIgnoreCase(sourceGroup)) return EnumSet.of(SkillSource.PROJECT_MBOO, SkillSource.GLOBAL_MBOO);
        if ("agents".equalsIgnoreCase(sourceGroup)) return EnumSet.of(SkillSource.PROJECT_AGENTS, SkillSource.GLOBAL_AGENTS);
        if ("builtin".equalsIgnoreCase(sourceGroup)) return EnumSet.of(SkillSource.BUILTIN);
        throw new ServiceException("Skill 来源参数错误");
    }

    private Path globalRoot(String ownerDirectory) {
        return Path.of(System.getProperty("user.home"), ownerDirectory, "skills").toAbsolutePath().normalize();
    }

    private int matchRank(SkillDescriptor descriptor, String query) {
        if (query.isEmpty() || descriptor.name().startsWith(query)) return 0;
        if (descriptor.name().contains(query)) return 1;
        return 2;
    }

    private boolean isSafeDirectoryName(String name) {
        if (name == null || name.isBlank() || name.length() > 255 || name.equals(".") || name.equals("..")) return false;
        try {
            Path path = Path.of(name);
            return !path.isAbsolute() && path.getNameCount() == 1 && path.getFileName().toString().equals(name);
        } catch (InvalidPathException e) {
            return false;
        }
    }

    private String hashFileTree(Path root, List<Path> files) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 不支持 SHA-256", e);
        }
        for (Path file : files) {
            String relative = normalizeRelative(root.relativize(file));
            digest.update(relative.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update((byte) 'F');
            digest.update((byte) 0);
            digest.update(Files.readAllBytes(file));
            digest.update((byte) 0);
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private String normalizeRelative(Path path) {
        return path.normalize().toString().replace('\\', '/');
    }

    private String normalizeRelativeResource(String resourcePath) {
        try {
            Path path = Path.of(resourcePath.replace('\\', '/')).normalize();
            String normalized = path.toString().replace('\\', '/');
            if (path.isAbsolute() || normalized.isBlank() || normalized.equals("..") || normalized.startsWith("../")) throw new ServiceException("Skill 资源路径无效");
            return normalized;
        } catch (InvalidPathException e) {
            throw new ServiceException("Skill 资源路径无效");
        }
    }

    private String decodeUtf8(byte[] bytes, String errorMessage) {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new SkillValidationException(errorMessage);
        }
    }

    private String tryDecodeUtf8(byte[] bytes) {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            return text.indexOf('\0') >= 0 ? null : text;
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private record ParsedFrontMatter(String name, String description, String content) {
    }

    private static class SkillValidationException extends RuntimeException {
        private SkillValidationException(String message) {
            super(message);
        }
    }
}
