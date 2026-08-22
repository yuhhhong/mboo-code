export interface GradleBuildCommand {
  command: string;
  arguments: string[];
}

/**
 * 通过 POSIX shell 调用仓库内 Gradle Wrapper，兼容 Git 未保留可执行位的工作树。
 */
export function createGradleBootJarCommand(platform: NodeJS.Platform, javaHome?: string): GradleBuildCommand {
  const argumentsList = ["bootJar"];
  if (javaHome) argumentsList.unshift(`-Dorg.gradle.java.installations.paths=${javaHome}`);
  if (platform === "win32") return { command: "gradlew.bat", arguments: argumentsList };
  return { command: "sh", arguments: ["./gradlew", ...argumentsList] };
}
