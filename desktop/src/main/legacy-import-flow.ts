import { importLegacyBusinessData } from "./data-migration.js";
import { inspectBusinessDataDirectory, shouldOfferLegacyDataImport, type BusinessDataType } from "./data-directory-inspection.js";
import path from "node:path";

export type LegacyImportDecision = "import" | "skip";

export interface LegacyImportResult {
  decision: "not-offered" | "skip" | "imported";
  types: BusinessDataType[];
}

export interface LegacyImportOptions {
  allowReplaceTarget?: boolean;
}

/**
 * 将导入判断和用户确认收敛在服务启动前；只有显式确认才会调用复制逻辑，跳过不会改变任何业务文件。
 */
export async function runLegacyImportFlow(
  targetDirectory: string,
  legacyDirectory: string,
  requestDecision: (types: BusinessDataType[]) => Promise<LegacyImportDecision>,
  options: LegacyImportOptions = {},
): Promise<LegacyImportResult> {
  if (path.resolve(targetDirectory) === path.resolve(legacyDirectory)) {
    return { decision: "not-offered", types: [] };
  }

  const legacy = await inspectBusinessDataDirectory(legacyDirectory);
  const canOffer = options.allowReplaceTarget
    ? legacy.hasBusinessData
    : await shouldOfferLegacyDataImport(targetDirectory, legacyDirectory);
  if (!canOffer) {
    return { decision: "not-offered", types: [] };
  }

  const decision = await requestDecision(legacy.types);
  if (decision === "skip") {
    return { decision: "skip", types: legacy.types };
  }

  const imported = await importLegacyBusinessData(legacyDirectory, targetDirectory, options);
  return { decision: "imported", types: imported.types };
}
