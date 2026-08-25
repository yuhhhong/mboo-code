package com.yu.mboocode.agent.skill;

import cn.hutool.core.util.StrUtil;
import com.yu.mboocode.agent.model.Workspace;
import com.yu.mboocode.agent.service.WorkspaceService;
import com.yu.mboocode.agent.skill.dto.SkillResp;
import com.yu.mboocode.agent.skill.dto.SkillImportPreviewResp;
import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.agent.skill.model.SkillStatus;
import com.yu.mboocode.agent.util.WorkspacePathUtil;
import com.yu.mboocode.common.exception.ServiceException;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.commons.compress.archivers.zip.ZipArchiveInputStream;
import org.apache.commons.compress.archivers.zip.UnixStat;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Skill 导入、原子替换和删除。所有上传先进入目标来源旁的临时目录，完整校验通过后才移动到正式目录。
 */
@Service
@Slf4j
public class SkillImportService {
    private static final long MAX_ARCHIVE_BYTES = 4L * 1024 * 1024;
    private static final int MAX_RELATIVE_PATH_LENGTH = 512;
    private static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");

    @Resource
    private WorkspaceService workspaceService;
    @Resource
    private SkillRegistry skillRegistry;

    public SkillResp importSkill(String target, String workspaceId, boolean replace, MultipartFile archive, List<MultipartFile> files,
                                 List<String> relativePaths, MultipartFile skillFile) {
        ImportTarget importTarget = resolveTarget(target, workspaceId);
        return workspaceService.withOperationLock(importTarget.workspaceId(), () -> doImport(importTarget, replace, archive, files, relativePaths, skillFile));
    }

    public SkillImportPreviewResp preview(String target, String workspaceId, MultipartFile archive, List<MultipartFile> files,
                                          List<String> relativePaths, MultipartFile skillFile) {
        ImportTarget importTarget = resolveTarget(target, workspaceId);
        return workspaceService.withOperationLock(importTarget.workspaceId(),
                () -> doPreview(importTarget, archive, files, relativePaths, skillFile));
    }

    public void delete(SkillSource source, String name, String workspaceId) {
        if (source != SkillSource.PROJECT_MBOO && source != SkillSource.GLOBAL_MBOO) throw new ServiceException("该 Skill 来源不允许删除");
        ImportTarget target = source == SkillSource.PROJECT_MBOO ? resolveTarget("PROJECT", workspaceId) : resolveTarget("GLOBAL", null);
        workspaceService.withOperationLock(target.workspaceId(), () -> {
            deleteManagedSkill(target, name);
            return null;
        });
    }

    private SkillResp doImport(ImportTarget target, boolean replace, MultipartFile archive, List<MultipartFile> files,
                               List<String> relativePaths, MultipartFile skillFile) {
        ImportInput input = validateInput(archive, files, skillFile);

        Path stageRoot = null;
        Path backup = null;
        Path installedTarget = null;
        try {
            Files.createDirectories(target.skillsRoot().getParent());
            Path managedParent = requireManagedPath(target.skillsRoot().getParent(), target.boundaryRoot(), "Skill 目标目录越过管理边界");
            stageRoot = Files.createTempDirectory(managedParent, ".skill-stage-");
            Path inputRoot = Files.createDirectory(stageRoot.resolve("input"));
            materializeInput(input, archive, files, relativePaths, skillFile, inputRoot);

            Path skillRoot = locateSingleSkillRoot(inputRoot);
            SkillDescriptor descriptor = skillRegistry.validateImportDirectory(skillRoot, target.source(), target.workspaceId(), target.workspaceName());
            if (descriptor.status() != SkillStatus.VALID) throw new ServiceException(descriptor.errorMessage());

            Files.createDirectories(target.skillsRoot());
            Path normalizedSkillsRoot = requireManagedPath(target.skillsRoot(), target.boundaryRoot(), "Skill 来源根目录越过管理边界");
            installedTarget = normalizedSkillsRoot.resolve(descriptor.name()).normalize();
            if (!installedTarget.getParent().equals(normalizedSkillsRoot)) throw new ServiceException("Skill 安装目标无效");
            if (Files.exists(installedTarget, LinkOption.NOFOLLOW_LINKS) && !replace) throw new ServiceException("目标 .mboo 已存在同名 Skill，请明确选择替换");
            if (Files.isSymbolicLink(installedTarget)) throw new ServiceException("目标 Skill 目录类型不安全，无法替换");

            if (Files.exists(installedTarget, LinkOption.NOFOLLOW_LINKS)) {
                backup = stageRoot.resolve("backup");
                moveAtomic(installedTarget, backup);
            }
            try {
                moveAtomic(skillRoot, installedTarget);
            } catch (Exception e) {
                if (backup != null && Files.exists(backup, LinkOption.NOFOLLOW_LINKS) && !Files.exists(installedTarget, LinkOption.NOFOLLOW_LINKS)) {
                    moveAtomic(backup, installedTarget);
                    backup = null;
                }
                throw e;
            }
            if (backup != null) {
                try {
                    deleteTree(backup);
                } catch (IOException e) {
                    log.warn("Skill 替换备份清理失败 name:{} source:{} workspaceId:{}", descriptor.name(), target.source(), target.workspaceId());
                }
                backup = null;
            }
            SkillResp response = skillRegistry.list("mboo", target.workspaceId()).stream()
                    .filter(item -> item.source() == target.source() && item.name().equals(descriptor.name())
                            && java.util.Objects.equals(item.workspaceId(), target.workspaceId())).findFirst()
                    .orElseThrow(() -> new ServiceException("Skill 已安装但重新扫描失败"));
            log.info("Skill 导入完成 name:{} source:{} workspaceId:{} size:{} files:{} hash:{}", descriptor.name(), target.source(),
                    target.workspaceId(), descriptor.totalSize(), descriptor.fileCount(), hashPrefix(descriptor.contentHash()));
            return response;
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            log.warn("Skill 导入失败 source:{} workspaceId:{}", target.source(), target.workspaceId());
            throw new ServiceException("Skill 导入失败，请检查压缩包或目录结构");
        } finally {
            if (backup != null && installedTarget != null) {
                try {
                    if (!Files.exists(installedTarget, LinkOption.NOFOLLOW_LINKS)) moveAtomic(backup, installedTarget);
                } catch (Exception e) {
                    log.error("Skill 替换回滚失败 source:{} workspaceId:{}", target.source(), target.workspaceId());
                }
            }
            if (stageRoot != null) {
                try {
                    deleteTree(stageRoot);
                } catch (Exception e) {
                    log.warn("Skill 导入临时目录清理失败 source:{} workspaceId:{}", target.source(), target.workspaceId());
                }
            }
        }
    }

    private SkillImportPreviewResp doPreview(ImportTarget target, MultipartFile archive, List<MultipartFile> files,
                                             List<String> relativePaths, MultipartFile skillFile) {
        ImportInput input = validateInput(archive, files, skillFile);
        Path stageRoot = null;
        try {
            stageRoot = Files.createTempDirectory("mboo-skill-preview-");
            Path inputRoot = Files.createDirectory(stageRoot.resolve("input"));
            materializeInput(input, archive, files, relativePaths, skillFile, inputRoot);
            Path skillRoot = locateSingleSkillRoot(inputRoot);
            SkillDescriptor descriptor = skillRegistry.validateImportDirectory(skillRoot, target.source(), target.workspaceId(), target.workspaceName());
            if (descriptor.status() != SkillStatus.VALID) throw new ServiceException(descriptor.errorMessage());
            boolean conflict = false;
            if (Files.exists(target.skillsRoot().getParent(), LinkOption.NOFOLLOW_LINKS)) {
                requireManagedPath(target.skillsRoot().getParent(), target.boundaryRoot(), "Skill 目标目录越过管理边界");
            }
            if (Files.exists(target.skillsRoot(), LinkOption.NOFOLLOW_LINKS)) {
                Path skillsRoot = requireManagedPath(target.skillsRoot(), target.boundaryRoot(), "Skill 来源根目录越过管理边界");
                conflict = Files.exists(skillsRoot.resolve(descriptor.name()), LinkOption.NOFOLLOW_LINKS);
            }
            String targetDisplayPath = target.workspaceName() == null ? "~/.mboo/skills/" + descriptor.name()
                    : target.workspaceName() + "/.mboo/skills/" + descriptor.name();
            return new SkillImportPreviewResp(descriptor.name(), descriptor.description(), target.source(), target.workspaceId(), target.workspaceName(),
                    targetDisplayPath, descriptor.contentSize(), descriptor.totalSize(), descriptor.fileCount(), descriptor.resourceCount(),
                    descriptor.contentHash(), conflict);
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            log.warn("Skill 导入预览失败 source:{} workspaceId:{}", target.source(), target.workspaceId());
            throw new ServiceException("Skill 导入预览失败，请检查压缩包或目录结构");
        } finally {
            if (stageRoot != null) {
                try {
                    deleteTree(stageRoot);
                } catch (Exception e) {
                    log.warn("Skill 导入预览临时目录清理失败 source:{} workspaceId:{}", target.source(), target.workspaceId());
                }
            }
        }
    }

    private ImportInput validateInput(MultipartFile archive, List<MultipartFile> files, MultipartFile skillFile) {
        boolean hasArchive = archive != null && !archive.isEmpty();
        boolean hasFiles = files != null && files.stream().anyMatch(file -> file != null && !file.isEmpty());
        boolean hasSkillFile = skillFile != null && !skillFile.isEmpty();
        if ((hasArchive ? 1 : 0) + (hasFiles ? 1 : 0) + (hasSkillFile ? 1 : 0) != 1) {
            throw new ServiceException("archive、files 与 skillFile 必须且只能提供一种");
        }
        return hasArchive ? ImportInput.ARCHIVE : hasFiles ? ImportInput.FOLDER : ImportInput.MARKDOWN;
    }

    private void materializeInput(ImportInput input, MultipartFile archive, List<MultipartFile> files, List<String> relativePaths,
                                  MultipartFile skillFile, Path inputRoot) throws IOException {
        if (input == ImportInput.ARCHIVE) extractArchive(archive, inputRoot);
        if (input == ImportInput.FOLDER) copyFolderFiles(files, relativePaths, inputRoot);
        if (input == ImportInput.MARKDOWN) copySingleMarkdown(skillFile, inputRoot);
    }

    private void extractArchive(MultipartFile archive, Path inputRoot) throws IOException {
        String filename = StrUtil.nullToEmpty(archive.getOriginalFilename());
        if (!filename.toLowerCase(Locale.ROOT).endsWith(".zip")) throw new ServiceException("第一版只支持 ZIP 压缩包");
        if (archive.getSize() > MAX_ARCHIVE_BYTES) throw new ServiceException("ZIP 上传大小超过 4 MiB");
        long totalBytes = 0;
        int fileCount = 0;
        Set<String> normalizedEntries = new HashSet<>();
        try (ZipArchiveInputStream input = new ZipArchiveInputStream(archive.getInputStream())) {
            ZipArchiveEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = input.getNextEntry()) != null) {
                String name = validateUploadPath(entry.getName(), normalizedEntries);
                int unixMode = entry.getUnixMode();
                if (entry.isUnixSymlink() || (!entry.isDirectory() && unixMode != 0 && (unixMode & UnixStat.FILE_TYPE_FLAG) != UnixStat.FILE_FLAG)) {
                    throw new ServiceException("ZIP 包含符号链接、硬链接或不支持的文件类型");
                }
                Path destination = inputRoot.resolve(name).normalize();
                if (!destination.startsWith(inputRoot)) throw new ServiceException("ZIP 路径越过 Skill 目录");
                if (entry.isDirectory()) {
                    Files.createDirectories(destination);
                    continue;
                }
                fileCount++;
                if (fileCount > SkillRegistry.MAX_SKILL_FILES) throw new ServiceException("Skill 文件数量超过 128 个");
                Files.createDirectories(destination.getParent());
                try (OutputStream output = Files.newOutputStream(destination)) {
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        if (read == 0) continue;
                        totalBytes += read;
                        if (totalBytes > SkillRegistry.MAX_SKILL_TOTAL_BYTES) throw new ServiceException("Skill 解压后总大小超过 4 MiB");
                        output.write(buffer, 0, read);
                    }
                }
            }
        }
        if (fileCount == 0) throw new ServiceException("ZIP 中没有 Skill 文件");
    }

    private void copyFolderFiles(List<MultipartFile> files, List<String> relativePaths, Path inputRoot) throws IOException {
        List<MultipartFile> actualFiles = files.stream().filter(file -> file != null && !file.isEmpty()).toList();
        if (actualFiles.size() > SkillRegistry.MAX_SKILL_FILES) throw new ServiceException("Skill 文件数量超过 128 个");
        if (relativePaths != null && !relativePaths.isEmpty() && relativePaths.size() != files.size()) throw new ServiceException("文件夹相对路径数量不匹配");
        long totalBytes = 0;
        Set<String> normalizedEntries = new HashSet<>();
        for (int i = 0; i < files.size(); i++) {
            MultipartFile file = files.get(i);
            if (file == null || file.isEmpty()) continue;
            String submittedPath = relativePaths != null && relativePaths.size() == files.size() ? relativePaths.get(i) : file.getOriginalFilename();
            String relativePath = validateUploadPath(submittedPath, normalizedEntries);
            totalBytes += file.getSize();
            if (totalBytes > SkillRegistry.MAX_SKILL_TOTAL_BYTES) throw new ServiceException("Skill 文件夹总大小超过 4 MiB");
            Path destination = inputRoot.resolve(relativePath).normalize();
            if (!destination.startsWith(inputRoot)) throw new ServiceException("文件夹路径越过 Skill 目录");
            Files.createDirectories(destination.getParent());
            try (InputStream input = file.getInputStream()) {
                Files.copy(input, destination);
            }
        }
    }

    private void copySingleMarkdown(MultipartFile skillFile, Path inputRoot) throws IOException {
        String filename = StrUtil.nullToEmpty(skillFile.getOriginalFilename());
        if (!filename.toLowerCase(Locale.ROOT).endsWith(".md")) throw new ServiceException("单文件导入只支持 .md 文件");
        if (skillFile.getSize() > SkillRegistry.MAX_SKILL_MARKDOWN_BYTES) throw new ServiceException("SKILL.md 超过 256 KiB");
        try (InputStream input = skillFile.getInputStream()) {
            Files.copy(input, inputRoot.resolve("SKILL.md"));
        }
    }

    private Path locateSingleSkillRoot(Path inputRoot) throws IOException {
        if (Files.isRegularFile(inputRoot.resolve("SKILL.md"), LinkOption.NOFOLLOW_LINKS)) return inputRoot;
        List<Path> children;
        try (var stream = Files.list(inputRoot)) {
            children = stream.toList();
        }
        if (children.size() == 1 && Files.isDirectory(children.getFirst(), LinkOption.NOFOLLOW_LINKS)
                && Files.isRegularFile(children.getFirst().resolve("SKILL.md"), LinkOption.NOFOLLOW_LINKS)) return children.getFirst();
        throw new ServiceException("导入内容必须在根部或唯一一层包装目录中包含 SKILL.md");
    }

    private String validateUploadPath(String rawPath, Set<String> normalizedEntries) {
        if (StrUtil.isBlank(rawPath) || rawPath.indexOf('\0') >= 0) throw new ServiceException("上传文件路径无效");
        String slashPath = rawPath.replace('\\', '/');
        if (slashPath.startsWith("/") || slashPath.matches("^[A-Za-z]:.*") || slashPath.length() > MAX_RELATIVE_PATH_LENGTH) {
            throw new ServiceException("上传文件路径不是安全的相对路径");
        }
        if (WINDOWS) {
            if (slashPath.contains(":")) throw new ServiceException("上传文件路径包含 Windows 不支持的特殊语义");
            for (String segment : slashPath.split("/")) {
                String lower = segment.toLowerCase(Locale.ROOT);
                String stem = lower.contains(".") ? lower.substring(0, lower.indexOf('.')) : lower;
                if (segment.endsWith(".") || segment.endsWith(" ") || stem.matches("con|prn|aux|nul|com[1-9]|lpt[1-9]")) {
                    throw new ServiceException("上传文件路径包含 Windows 保留名称");
                }
            }
        }
        try {
            Path path = Path.of(slashPath).normalize();
            String normalized = path.toString().replace('\\', '/');
            if (path.isAbsolute() || normalized.isBlank() || normalized.equals("..") || normalized.startsWith("../")) {
                throw new ServiceException("上传文件路径越过 Skill 目录");
            }
            String duplicateKey = WINDOWS ? normalized.toLowerCase(Locale.ROOT) : normalized;
            if (!normalizedEntries.add(duplicateKey)) throw new ServiceException("上传内容包含重复规范化路径");
            return normalized;
        } catch (InvalidPathException e) {
            throw new ServiceException("上传文件路径无效");
        }
    }

    private void deleteManagedSkill(ImportTarget target, String name) {
        if (!isSafeDirectoryName(name)) throw new ServiceException("Skill 名称无效");
        if (!Files.exists(target.skillsRoot(), LinkOption.NOFOLLOW_LINKS)) throw new ServiceException("Skill 不存在");
        Path skillsRoot;
        try {
            skillsRoot = requireManagedPath(target.skillsRoot(), target.boundaryRoot(), "Skill 来源根目录越过管理边界");
        } catch (IOException e) {
            throw new ServiceException("Skill 来源目录无法安全解析");
        }
        Path skillPath = skillsRoot.resolve(name).normalize();
        if (!skillPath.getParent().equals(skillsRoot)) throw new ServiceException("Skill 删除目标无效");
        if (!Files.exists(skillPath, LinkOption.NOFOLLOW_LINKS)) throw new ServiceException("Skill 不存在");
        if (Files.isSymbolicLink(skillPath)) throw new ServiceException("Skill 目录类型不安全，无法删除");
        try {
            Path realRoot = skillsRoot.toRealPath();
            Path realSkill = skillPath.toRealPath();
            if (!realSkill.getParent().equals(realRoot)) throw new ServiceException("Skill 删除目标越过来源边界");
            deleteTree(realSkill);
            log.info("Skill 删除完成 name:{} source:{} workspaceId:{}", name, target.source(), target.workspaceId());
        } catch (IOException e) {
            throw new ServiceException("Skill 删除失败");
        }
    }

    private ImportTarget resolveTarget(String target, String workspaceId) {
        if ("GLOBAL".equalsIgnoreCase(target)) {
            Path userHome = Path.of(System.getProperty("user.home")).toAbsolutePath().normalize();
            return new ImportTarget(SkillSource.GLOBAL_MBOO, null, null, userHome.resolve(".mboo/skills"), userHome);
        }
        if (!"PROJECT".equalsIgnoreCase(target)) throw new ServiceException("Skill 导入目标必须是 PROJECT 或 GLOBAL");
        if (StrUtil.isBlank(workspaceId)) throw new ServiceException("项目级 Skill 必须选择工作区");
        Workspace workspace = workspaceService.getById(workspaceId);
        if (workspace == null) throw new ServiceException("工作区不存在");
        if (!WorkspacePathUtil.isAvailable(workspace.getPath())) throw new ServiceException("工作区当前不可用");
        Path workspacePath = Path.of(workspace.getPath()).toAbsolutePath().normalize();
        String workspaceName = workspacePath.getFileName() == null ? workspace.getPath() : workspacePath.getFileName().toString();
        return new ImportTarget(SkillSource.PROJECT_MBOO, workspace.getId(), workspaceName, workspacePath.resolve(".mboo/skills"), workspacePath);
    }

    private Path requireManagedPath(Path path, Path boundaryRoot, String errorMessage) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) throw new ServiceException(errorMessage);
        Path realBoundary = boundaryRoot.toRealPath();
        Path realPath = path.toRealPath();
        if (!realPath.startsWith(realBoundary)) throw new ServiceException(errorMessage);
        return realPath;
    }

    private void moveAtomic(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target);
        }
    }

    private void deleteTree(Path root) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
        try (var walk = Files.walk(root)) {
            List<Path> paths = new ArrayList<>(walk.toList());
            paths.sort(Comparator.reverseOrder());
            for (Path path : paths) Files.deleteIfExists(path);
        }
    }

    private String hashPrefix(String hash) {
        return hash == null ? "" : hash.substring(0, Math.min(12, hash.length()));
    }

    private boolean isSafeDirectoryName(String name) {
        if (StrUtil.isBlank(name) || name.length() > 255 || name.equals(".") || name.equals("..")) return false;
        try {
            Path path = Path.of(name);
            return !path.isAbsolute() && path.getNameCount() == 1 && path.getFileName().toString().equals(name);
        } catch (InvalidPathException e) {
            return false;
        }
    }

    private record ImportTarget(SkillSource source, String workspaceId, String workspaceName, Path skillsRoot, Path boundaryRoot) {
    }

    private enum ImportInput {
        ARCHIVE,
        FOLDER,
        MARKDOWN
    }
}
