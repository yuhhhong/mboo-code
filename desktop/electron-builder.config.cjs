const targetKey = process.env.MBOO_TARGET_KEY;
const signingMode = process.env.MBOO_SIGNING_MODE ?? "unsigned";
const electronMirror = process.env.ELECTRON_MIRROR?.trim() || "https://npmmirror.com/mirrors/electron/";

if (!new Set(["win32-x64", "darwin-x64", "darwin-arm64"]).has(targetKey)) {
  throw new Error("MBOO_TARGET_KEY 必须是 win32-x64、darwin-x64 或 darwin-arm64");
}

if (signingMode !== "unsigned" && signingMode !== "signed") {
  throw new Error("MBOO_SIGNING_MODE 必须是 unsigned 或 signed");
}

const isSignedBuild = signingMode === "signed";
const macIdentity = process.env.MBOO_MAC_IDENTITY ?? process.env.CSC_NAME;
const hasMacSigningCredentials = Boolean(
  macIdentity || process.env.CSC_LINK || process.env.CSC_KEYCHAIN_PROFILE || process.env.CSC_KEYCHAIN,
);
const hasMacNotarizationCredentials = Boolean(
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
  || (process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE),
);

if (isSignedBuild && targetKey.startsWith("darwin") && (!hasMacSigningCredentials || !hasMacNotarizationCredentials)) {
  throw new Error("macOS 签名凭据不完整：需要 Developer ID 证书来源和 electron-builder 支持的公证凭据");
}

if (isSignedBuild && targetKey === "win32-x64" && !process.env.WIN_CSC_LINK) {
  throw new Error("Windows 签名凭据不完整：需要 WIN_CSC_LINK 指向受保护的证书文件或 Secret");
}

module.exports = {
  appId: "com.yu.mboocode",
  productName: "Mboo Code",
  asar: true,
  directories: {
    output: "release",
  },
  files: [
    "dist/**/*",
    "package.json",
  ],
  electronDownload: {
    mirrorOptions: {
      mirror: electronMirror,
    },
  },
  extraResources: [
    {
      from: `build/resources/${targetKey}`,
      to: ".",
    },
    {
      from: "resources/THIRD_PARTY_NOTICES.md",
      to: "THIRD_PARTY_NOTICES.md",
    },
    {
      from: "dist/main/process-supervisor.js",
      to: "process-supervisor.js",
    },
  ],
  mac: {
    target: "dmg",
    category: "public.app-category.developer-tools",
    icon: "resources/icons/mboo-code.icns",
    ...(isSignedBuild ? (macIdentity ? { identity: macIdentity } : {}) : { identity: null }),
    notarize: isSignedBuild,
    artifactName: "Mboo-Code-${version}-mac-${arch}.${ext}",
  },
  dmg: {
    title: "Mboo Code ${version}",
  },
  win: {
    target: "nsis",
    icon: "resources/icons/mboo-code.png",
    forceCodeSigning: isSignedBuild,
    artifactName: "Mboo-Code-${version}-win-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};
