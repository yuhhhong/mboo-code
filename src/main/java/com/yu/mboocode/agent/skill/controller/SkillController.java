package com.yu.mboocode.agent.skill.controller;

import com.yu.mboocode.agent.skill.SkillImportService;
import com.yu.mboocode.agent.skill.SkillRegistry;
import com.yu.mboocode.agent.skill.dto.SkillDetailResp;
import com.yu.mboocode.agent.skill.dto.SkillResp;
import com.yu.mboocode.agent.skill.dto.SkillSuggestResp;
import com.yu.mboocode.agent.skill.dto.SkillImportPreviewResp;
import com.yu.mboocode.agent.skill.model.SkillSource;
import com.yu.mboocode.common.dto.R;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.annotation.Resource;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

@Tag(name = "Skill 管理")
@RestController
@RequestMapping("/skill")
public class SkillController {
    @Resource
    private SkillRegistry skillRegistry;
    @Resource
    private SkillImportService skillImportService;

    @Operation(summary = "按来源列出 Skill")
    @GetMapping("/list")
    public R<List<SkillResp>> list(@RequestParam String source, @RequestParam(required = false) String workspaceId) {
        return R.ok(skillRegistry.list(source, workspaceId));
    }

    @Operation(summary = "查看 Skill 详情或按需读取资源")
    @GetMapping("/detail")
    public R<SkillDetailResp> detail(@RequestParam SkillSource source, @RequestParam String name,
                                     @RequestParam(required = false) String workspaceId, @RequestParam(required = false) String resource) {
        return R.ok(skillRegistry.detail(source, name, workspaceId, resource));
    }

    @Operation(summary = "获取当前工作区的生效 Skill 联想")
    @GetMapping("/suggest")
    public R<List<SkillSuggestResp>> suggest(@RequestParam(required = false, defaultValue = "") String q,
                                             @RequestParam(required = false) String workspaceId) {
        return R.ok(skillRegistry.suggest(q, workspaceId));
    }

    @Operation(summary = "导入或替换项目级、全局 .mboo Skill")
    @PostMapping(value = "/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public R<SkillResp> importSkill(@RequestParam String target, @RequestParam(required = false) String workspaceId,
                                    @RequestParam(defaultValue = "false") boolean replace,
                                    @RequestParam(required = false) MultipartFile archive,
                                    @RequestParam(required = false) List<MultipartFile> files,
                                    @RequestParam(required = false) List<String> relativePaths,
                                    @RequestParam(required = false) MultipartFile skillFile) {
        return R.ok(skillImportService.importSkill(target, workspaceId, replace, archive, files, relativePaths, skillFile));
    }

    @Operation(summary = "解析 Skill 导入内容并返回规模与冲突预览")
    @PostMapping(value = "/import/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public R<SkillImportPreviewResp> previewImport(@RequestParam String target, @RequestParam(required = false) String workspaceId,
                                                   @RequestParam(required = false) MultipartFile archive,
                                                   @RequestParam(required = false) List<MultipartFile> files,
                                                   @RequestParam(required = false) List<String> relativePaths,
                                                   @RequestParam(required = false) MultipartFile skillFile) {
        return R.ok(skillImportService.preview(target, workspaceId, archive, files, relativePaths, skillFile));
    }

    @Operation(summary = "删除项目级或全局 .mboo Skill")
    @DeleteMapping
    public R<Void> delete(@RequestParam SkillSource source, @RequestParam String name, @RequestParam(required = false) String workspaceId) {
        skillImportService.delete(source, name, workspaceId);
        return R.ok();
    }
}
