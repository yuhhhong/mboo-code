# 第三方运行时说明

桌面端构建使用 [runtime/manifest.json](./runtime/manifest.json) 作为唯一下载与 SHA-256 校验清单。构建脚本必须校验归档文件后才解压，并将对应许可证随安装包分发。

| 组件 | 发行方 | 许可证 | 官方来源 |
| --- | --- | --- | --- |
| Eclipse Temurin 25 | Eclipse Adoptium | GPL-2.0-only WITH Classpath-exception-2.0 | <https://adoptium.net/> |
| Node.js 24.19.0 | Node.js Foundation | MIT | <https://nodejs.org/dist/v24.19.0/> |
| ripgrep 15.2.0 | BurntSushi | MIT OR Unlicense | <https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0> |

开发模式可以使用系统安装的运行时；桌面生产包只允许使用清单中与目标平台和 CPU 架构匹配的资源。
