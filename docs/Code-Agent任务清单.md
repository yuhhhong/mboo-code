# Code Agent 任务清单

## 当前

- 前端分页加载
- 多模态
- ocr

- 长期记忆工具 llm自动调用 向量化去重

- mcp
- skill（分段加载）
- rag
- 提示词缓存 成本优化

- langgraph框架使用
- 子agent独立skill mcp、提示词
- skill渐进加载 skill增加域路由

- 考虑多一个默认工作区，跟项目无关的下载到对应工作区

## 已完成

- 网络工具（`web_search`、`web_fetch`）

## 目标定位

本项目目标是做一个类似 Codex 的 code agent 后端 runtime。

第一版重点不是普通聊天，而是让 agent 能在指定工作区内理解代码、调用工具、修改文件、执行命令，并且把整个过程记录成可恢复、可审计的会话事件日志。

