# Mboo Code Desktop

Electron 桌面端负责托管当前 Java 后端和 Next.js standalone 前端，目标平台为 Windows x64、macOS x64 和 macOS arm64。

桌面 App 与浏览器开发模式共用用户主目录下的 `.mboo` 数据目录：SQLite、会话 JSONL、模型设置、工具结果和启动日志均写入 `~/.mboo`。桌面端会显式把该绝对路径传给 Java，避免打包模式切换到另一套数据。

## 环境要求

- macOS 或 Windows 构建机。
- Java 25：建议通过 `MBOO_JAVA_HOME` 指定 JDK/JRE 对应的 Java 25 安装目录。
- Node.js 20.9.0 或更高版本；当前仓库的桌面开发依赖使用 Node.js 24.19.0。
- npm。
- macOS 构建需要 Xcode Command Line Tools；Windows 构建需要 Windows SDK 和 NSIS 相关构建工具。

正式签名、公证和发布还需要相应平台的证书及安全存储，不应把证书或密钥写入仓库。

## 安装依赖

在项目根目录执行：

```text
cd desktop
npm ci
cd ../mboo-web
npm ci
```

网络较慢时，可只为当前命令使用 npm 国内镜像：

```text
npm_config_registry=https://registry.npmmirror.com npm ci --prefix desktop
npm_config_registry=https://registry.npmmirror.com npm ci --prefix mboo-web
```

Electron 下载源已固定在 `electron-builder.config.cjs`：

```text
https://npmmirror.com/mirrors/electron/
```

如果当前网络对该源访问较慢，可在构建命令中临时覆盖 Electron 镜像：

```text
ELECTRON_MIRROR=https://your-approved-mirror.example/electron/ npm run package:mac:arm64
```

镜像必须提供与 Electron 版本和平台架构对应的官方归档；构建失败时应恢复默认源或改用经过团队验证的镜像。

应用图标源文件位于 `desktop/resources/icons/mboo-code.png`。macOS 使用仓库内预生成的 `mboo-code.icns`，Windows 构建使用 PNG 源生成对应的 ICO 资源；修改图标后需要重新封包，已安装的旧 App 不会自动更新图标缓存。

运行时归档（Java、Node.js、`rg`）仍由 `resources/runtime/manifest.json` 固定来源和 SHA-256。构建脚本会优先复用 `desktop/.runtime-archives/<target>` 缓存，并在使用前重新校验；在公司网络中应使用 HTTPS 代理或提供内容完全一致的内部缓存，不应关闭校验或使用未知镜像替换归档。

## 开发与测试

```text
cd desktop
npm run build
npm test
```

Java 全量测试在项目根目录执行：

```text
MBOO_JAVA_HOME=/path/to/java25 sh ./gradlew test
```

如果当前终端已经设置了 `JAVA_HOME`，可以省略 `MBOO_JAVA_HOME`。桌面封包脚本会优先使用 `MBOO_JAVA_HOME`，其次使用 `JAVA_HOME`。

## 运行时准备与校验

按目标平台准备运行时资源：

```text
cd desktop
npm run prepare:runtime -- win32-x64
npm run prepare:runtime -- darwin-x64
npm run prepare:runtime -- darwin-arm64
npm run verify:runtime -- win32-x64
npm run verify:runtime -- darwin-x64
npm run verify:runtime -- darwin-arm64
```

`verify:runtime` 会检查 Java、Node.js、`rg` 的版本、SHA-256、CPU 架构以及 macOS 可执行权限。Windows 资源可以在 macOS 上做静态架构校验，但 Windows 真机启动、路径和进程回收仍须在 Windows runner 或 Windows 机器验证。

## 封包

```text
cd desktop
MBOO_JAVA_HOME=/path/to/java25 npm run package:mac:arm64
MBOO_JAVA_HOME=/path/to/java25 npm run package:mac:x64
MBOO_JAVA_HOME=/path/to/java25 npm run package:win:x64
```

封包产物写入 `desktop/release/`。当前脚本会重新构建 Electron、Java JAR 和 Next.js standalone 资源，再组装目标平台运行时，因此首次执行可能较慢；预热 `.runtime-archives` 后，后续构建会跳过已通过 SHA-256 校验的归档下载。

### Java 25 构建失败排查

如果出现 `Cannot find a Java installation ... languageVersion=25`，说明当前终端没有把 Java 25 传给 Gradle。macOS 可先确认 Homebrew Java 25，再使用同一条命令封包：

```text
MBOO_JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home npm run package:mac:arm64
```

Intel Mac 将目标命令替换为 `npm run package:mac:x64`；如果 Java 25 安装在其他位置，将路径替换为对应 JDK 根目录。仅设置 Java 23 或更低版本不能满足项目的 Java toolchain 要求。

## 签名与公证

内部验证默认使用未签名模式：

```text
MBOO_SIGNING_MODE=unsigned MBOO_JAVA_HOME=/path/to/java25 npm run package:mac:arm64
```

正式发布必须使用：

```text
MBOO_SIGNING_MODE=signed
```

Windows 使用 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`；macOS 使用 `CSC_LINK`/Keychain 或 `MBOO_MAC_IDENTITY`，并提供 electron-builder 支持的 Apple 公证凭据。凭据只允许来自 CI Secret、本机 Keychain 或其他安全存储。

## CI 工作流

- `.github/workflows/windows-desktop.yml`：Windows x64 测试和未签名 NSIS 封包。
- `.github/workflows/macos-desktop.yml`：macOS x64/arm64 测试和未签名 DMG 封包。
- `.github/workflows/signed-desktop-release.yml`：手动触发的三平台签名/公证封包，需要 GitHub Secrets `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`、`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_P8`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`。

Windows workflow 还会执行 `scripts/windows-installer-smoke.ps1`，使用临时目录验证 NSIS 静默安装、桌面服务 ready、进程树回收和卸载。

工作流可通过 GitHub Actions 手动触发。当前仓库已在 macOS 完成三目标资源静态校验和 macOS 两种架构的随包回归；Windows 真机安装、启动、卸载、中文/空格路径、空 PATH 下 `rg.exe` 和 Windows 进程树回收仍需 Windows runner 或 Windows 机器的实际结果。正式签名、公证和干净环境安装也不应以本地未签名包的结果代替。

## 相关文档

- `../docs/MbooCode桌面端开发文档.md`
- `../docs/MbooCode桌面端开发任务清单.md`
- `../docs/MbooCode桌面端发布清单.md`
- `../docs/MbooCode桌面端手测记录.md`
