export type SkillSource = "PROJECT_MBOO" | "PROJECT_AGENTS" | "GLOBAL_MBOO" | "GLOBAL_AGENTS" | "BUILTIN";
export type SkillStatus = "VALID" | "INVALID";

export type SkillListItem = {
  name: string;
  description: string;
  source: SkillSource;
  scope: "PROJECT" | "GLOBAL" | "BUILTIN";
  workspaceId?: string | null;
  workspaceName?: string | null;
  status: SkillStatus;
  errorMessage?: string | null;
  effective: boolean;
  shadowedBy?: SkillSource | null;
  contentSize: number;
  totalSize: number;
  fileCount: number;
  resourceCount: number;
  contentHash: string;
  canDelete: boolean;
  canReplace: boolean;
};

export type SkillDetail = SkillListItem & {
  skillMarkdown: string;
  resources: Array<{ relativePath: string; size: number; script: boolean; textReadable: boolean }>;
  resourcePath?: string | null;
  resourceContent?: string | null;
};

export type SkillSuggestion = { name: string; description: string; source: SkillSource };
export type SkillToken = { type: "skill"; name: string };
export type SkillImportPreview = {
  name: string;
  description: string;
  targetSource: SkillSource;
  workspaceId?: string | null;
  workspaceName?: string | null;
  targetDisplayPath: string;
  contentSize: number;
  totalSize: number;
  fileCount: number;
  resourceCount: number;
  contentHash: string;
  conflict: boolean;
};
