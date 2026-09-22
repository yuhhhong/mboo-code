# Mboo Code

**让 Agent 从"能回答"变成"能完成"，这是一个本地运行的 Code Agent 工作台，支持任务留痕、权限控制和过程回放。**

AI 负责干活，你负责摸鱼验收，赛博包工头模拟器，启动。

![Java](https://img.shields.io/badge/Java-25-ED8B00?logo=openjdk&logoColor=white)
![Spring Boot](https://img.shields.io/badge/Spring%20Boot-4.1-6DB33F?logo=springboot&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)

![Mboo Code 首页](./home.png)

## 它能帮你做什么

- **读懂一个陌生仓库**：通过文件模式查找、全文检索和分页读取带行号的内容，再直接跑命令验证，把"这块到底怎么工作的"问清楚。
- **跨文件改造**：局部修改走精确替换，每次都能拿到改动范围和 Unified Diff，不只收到一句"我帮你改好了"。
- **改完就地验证**：直接跑构建、测试、lint。命令执行有超时、可取消，也能连子进程一起终止；超长输出不会把上下文冲垮，原文另行保存供你查看。
- **接进你自己的工具链**：用 MCP 连内部服务，用 Skill 固化团队规范和工作流，让它按你的方式干活，按团队规范和工作流执行。

## 为什么是它

### 1. 权限按能力维度划分

权限按能力维度划分。读文件、写文件、执行命令、访问网络各有各的边界，不采用笼统的"允许它调用工具"。每次判定明确区分三种结果：直接放行、需要你确认、直接拒绝。拒绝不会被伪装成"你授权一下就能过"。

授权粒度由你决定：只放行这一次，或者在本会话内持续有效。命令授权绑定的是**命令原文、真实工作目录和 Shell 身份**。同一条命令换个目录就得重新授权；工具真正执行前还会重新走一遍权限判定，复核最终参数，防止授权之后目标被掉包。

即使切到完全访问模式，也只是把"需要确认"自动放行。内置规则的硬拒绝和路径越界照拦不误。

工具返回的是结构化结果，成功与否、错误类型都有明确字段，Agent 能直接判断该重试、缩小范围还是停手，不用从自然语言里猜执行状态。

### 2. 会话是可回放的事件流

一轮任务被拆成一串带明确语义的事件：你说了什么、模型回了什么、调了哪个工具、什么时候停下来等授权、上下文什么时候被压缩、哪里出错、哪里被取消。需要留痕的事件落进本地日志，纯粹的实时增量（比如逐字输出）不进历史。

每条事件有唯一标识，按幂等方式追加，重复写入直接跳过；进程异常中断留下的残缺记录，会在下次写入前自动清理。实时推送和历史回放共用同一套事件语义。刷新页面、切换会话、翻归档记录，看到的都是同一个过程，前端不需要维护两套互相漂移的状态。

大体积的工具结果和命令原始输出单独存放，主日志只留索引和预览，回放快，原文也不丢。

### 3. 上下文按模型真实能力治理

上下文窗口、输出上限和推理选项来自模型能力目录与供应商模型列表的匹配结果，不写死为常量；本地缓存优先，后台刷新，不阻塞启动。你也可以给具体模型单独指定窗口大小。

输入区显示的是真实 token 用量和占比，不靠字符数估算。接近阈值会自动压缩，你也可以主动触发。早期历史压成摘要，近期消息保留原文，两者分开持久化。长任务的结论留住了，最近的交互细节也没丢。压缩的开始、完成、跳过、失败和取消，同样是事件流的一部分。

### 4. 全部跑在你自己的机器上

工作区、会话元数据、可回放事件和工具原始输出，默认全部落在用户目录下的应用数据目录里，不需要外部数据库，也不需要消息队列。

会话创建时就固定工作区路径，之后相对路径、授权范围和历史工具记录都有稳定基准，路径身份跨平台正确处理。删除工作区只清理应用内的记录，**不碰你磁盘上的代码仓库**。

联网同样不交给模型判断：本机和内网地址默认不可达，开启能力之后仍要按来源单独授权；重定向后的目标要重新过一遍同样的检查。抓网页不执行 JavaScript、不带 Cookie、不复用浏览器登录态，URL 里的密钥类参数不会原样进事件和日志。

### 5. 接得进现有环境：Skill + MCP

Skill 是可按需激活的行为指令包，用来给 Agent 补上领域知识和固定工作流程。来源分项目级、全局级和内置三层，项目级优先。团队规范跟着仓库走，个人习惯留在全局。输入框里就能直接联想激活，模型也可以自己判断该用哪个。

MCP 让你把内部服务接进来，启用之后工具自动发现，自动加入后续对话。

两者都使用轮次级的不可变快照。你在半路改配置、导入或删除，不会影响正在跑的那一轮。Skill 里的脚本最终还是走命令执行那条路，照样守命令权限和工作区边界，Skill 中的内容同样需要授权。

### 6. 拿不准的时候，它会问你

遇到会影响结果、范围或验收标准的关键歧义，Agent 可以停下来反问，给出问题、候选答案和推荐项，你点一下就继续，不用中断思路去组织一段自然语言。

比起猜错方向跑出一百步再返工，先问一句便宜太多了。

## 安装使用

### 下载安装包（推荐）

1. 从 [Releases](https://github.com/yuhhhong/mboo-code/releases) 下载对应平台的安装包：Windows x64 `.exe`、macOS Intel / Apple Silicon `.dmg`
2. 安装后打开，在设置页填入模型服务的 `Base URL` 和 `API Key`
3. 选一个项目目录，开干

> **macOS 用户注意**：当前安装包未签名，首次打开可能提示"已损坏，无法打开"。把应用拖进「应用程序」后执行：
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Mboo Code.app"
> open "/Applications/Mboo Code.app"
> ```
>
> Windows 上 SmartScreen 可能提示未知发布者，选择"仍要运行"即可。

### 从源码运行

环境要求：JDK 25、Node.js 20.9+、npm、ripgrep 13+（`rg` 已加入 `PATH`）。

```bash
git clone https://github.com/yuhhhong/mboo-code.git
cd mboo-code
```

启动后端，默认 `http://localhost:8899`，Swagger UI 在 `/doc.html`：

```bash
./gradlew bootRun
```

Windows 用 `.\gradlew.bat bootRun`。

启动前端，打开 `http://localhost:3333`：

```bash
cd mboo-web && npm ci && npm run dev
```

后端不在默认地址时，用环境变量 `MBOO_API_BASE_URL` 指向它。桌面端的运行时准备、封包、签名和 CI 流程见 [`desktop/README.md`](./desktop/README.md)。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| Agent Runtime | Java 25 · Spring Boot 4.1 · LangChain4j 1.19 |
| 数据 | SQLite · MyBatis-Plus · JSONL 事件日志 |
| Web 前端 | Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 |
| 状态与通信 | TanStack Query · Zustand · Server-Sent Events |
| 桌面端 | Electron 43 · electron-builder |
| 文件检索 | ripgrep |

## 配置

应用数据默认放在用户目录的 `.mboo` 下，模型服务配置写在 `~/.mboo/setting.json`（Windows 是 `%USERPROFILE%\.mboo\setting.json`）。首次启动会自动创建；没配置时应用照常启动，只是还不能开始对话。

最小可用配置如下。

```json
{
  "api_key": "your-api-key",
  "base_url": "https://api.openai.com/v1"
}
```

`base_url` 通常需要带 `/v1`，并且要能响应 `GET {base_url}/models`。

其余可选项都在设置页里：Exa 搜索 Key、私有网络抓取开关、文件忽略规则及其例外。设置页还支持连接测试和 API Key 脱敏展示。

**配置保存后需要重启才生效**。桌面端可以直接点「立即重启」，浏览器开发模式需要手动重启后端。

数据根目录可以用 JVM 参数改：`java -Dmboo.appDataDir=/path/to/data -jar build/libs/mboo-code.jar`。

## 现状与限制

- **早期版本**，配置项、接口和数据结构仍可能调整。
- **只支持 OpenAI Responses API 协议**，不支持 Chat Completions；兼容服务还需要提供 `GET {base_url}/models`。
- **模型需要双匹配**：既要出现在供应商的 `/models` 列表里，也要能在 models.dev 找到能力信息，不接受手填任意模型 ID。
