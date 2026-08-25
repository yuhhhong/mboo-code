package com.yu.mboocode.agent.skill;

import com.yu.mboocode.agent.skill.model.SkillDescriptor;
import com.yu.mboocode.agent.skill.model.SkillResourceDescriptor;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.common.util.AppDataPaths;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 为内置 Skill 脚本提供按 contentHash 固定的文件系统缓存；这里只复制内容，不启动任何进程。
 */
@Service
@Slf4j
public class SkillScriptCache {
    public String activationContent(SkillDescriptor descriptor) {
        List<SkillResourceDescriptor> scripts = descriptor.resources().stream().filter(SkillResourceDescriptor::script).toList();
        if (scripts.isEmpty()) return descriptor.content();
        List<String> paths = new ArrayList<>();
        for (SkillResourceDescriptor script : scripts) {
            Path path = resolveScript(descriptor, script);
            if (path != null) paths.add(script.relativePath() + " = " + path);
        }
        if (paths.isEmpty()) return descriptor.content();
        return descriptor.content() + "\n\n<skill-script-paths>\n以下路径只定位脚本；如需执行，仍必须调用 run_command 并遵守完整权限链。\n"
                + String.join("\n", paths) + "\n</skill-script-paths>";
    }

    private Path resolveScript(SkillDescriptor descriptor, SkillResourceDescriptor script) {
        try {
            if (descriptor.source() != SkillSource.BUILTIN) {
                if (descriptor.rootPath() == null) return null;
                Path root = descriptor.rootPath().toRealPath();
                Path path = root.resolve(script.relativePath()).normalize();
                if (!path.startsWith(root) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
                return path.toRealPath();
            }
            if (script.textContent() == null) return null;
            Path cacheRoot = AppDataPaths.root().resolve("cache").resolve("skills").resolve(descriptor.name()).resolve(descriptor.contentHash());
            Path target = cacheRoot.resolve(script.relativePath()).normalize();
            if (!target.startsWith(cacheRoot)) return null;
            if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) materializeBuiltinScripts(descriptor, cacheRoot);
            return Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS) ? target.toAbsolutePath().normalize() : null;
        } catch (IOException e) {
            log.warn("内置 Skill 脚本缓存失败 name:{} hash:{}", descriptor.name(), hashPrefix(descriptor.contentHash()));
            return null;
        }
    }

    private void materializeBuiltinScripts(SkillDescriptor descriptor, Path cacheRoot) throws IOException {
        Files.createDirectories(cacheRoot.getParent());
        Path stage = Files.createTempDirectory(cacheRoot.getParent(), ".cache-stage-");
        try {
            for (SkillResourceDescriptor resource : descriptor.resources()) {
                if (!resource.script() || resource.textContent() == null) continue;
                Path target = stage.resolve(resource.relativePath()).normalize();
                if (!target.startsWith(stage)) continue;
                Files.createDirectories(target.getParent());
                Files.writeString(target, resource.textContent(), StandardCharsets.UTF_8);
                target.toFile().setReadOnly();
            }
            if (Files.exists(cacheRoot, LinkOption.NOFOLLOW_LINKS)) return;
            try {
                Files.move(stage, cacheRoot, StandardCopyOption.ATOMIC_MOVE);
            } catch (FileAlreadyExistsException e) {
                return;
            } catch (AtomicMoveNotSupportedException e) {
                try {
                    Files.move(stage, cacheRoot);
                } catch (FileAlreadyExistsException ignored) {
                    return;
                }
            }
            stage = null;
        } finally {
            if (stage != null) deleteTree(stage);
        }
    }

    private void deleteTree(Path root) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
        try (var walk = Files.walk(root)) {
            List<Path> paths = new ArrayList<>(walk.toList());
            paths.sort(Comparator.reverseOrder());
            for (Path path : paths) {
                path.toFile().setWritable(true);
                Files.deleteIfExists(path);
            }
        }
    }

    private String hashPrefix(String hash) {
        return hash == null ? "" : hash.substring(0, Math.min(12, hash.length()));
    }
}
