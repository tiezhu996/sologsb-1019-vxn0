# 访谈文本主题编码工具

`sologsb-1019` 是一个面向质性研究者的本地优先主题编码工作台，使用 SolidJS、TypeScript 和 SUID 从零构建。

## 功能

- 导入带时间码或普通段落形式的访谈转写，自动切分片段。
- 创建任意层级主题树，维护操作定义、备忘录和典型示例。
- 为每个片段分别记录两位编码者的主题判断，并高亮分歧。
- 批量选择片段后重新编码，支持主题合并和按片段拆分。
- 从主题引用快速回到原文，并保留主题级与片段级研究记录。
- 完整撤销重做、操作审计、JSON 完整备份和 CSV 编码结果导出。
- J/K、数字键、Alt+A/Alt+B、搜索与通用撤销快捷键。
- 使用 IndexedDB 保存权威快照与待提交记录（outbox/WAL），localStorage 仅作浏览级镜像；刷新、断网、浏览器崩溃后自动恢复重试。
- 每次编码改动先落盘为「带基础修订的待提交记录」，再在单事务内原子写入主题、片段判断和审计；成功提交后才清除记录。
- 多标签页并发时以基础修订做乐观并发控制：对方先提交不会被覆盖，本页改动完整保留，研究者可在「未完成提交」面板逐项选择在最新修订上重放或放弃。
- 导出 JSON 包含最终修订（`finalRevision`）与全部未完成提交（`pendingCommits`，含状态、基础修订、影响实体与失败原因）。

## 技术栈

- SolidJS 1.9
- TypeScript 5.9
- SUID Material `@suid/material`
- Vite 7
- IndexedDB / localStorage / BroadcastChannel

## 开发

```bash
npm install
npm run dev
```

开发服务器使用 Vite 默认端口，不在源码中硬编码宿主端口。

## 生产构建

```bash
npm run build
npm run preview
```

生产文件输出到 `dist/`。

## Docker

```bash
docker build -t sologsb-1019 .
docker run --rm -p 10019:80 sologsb-1019
```

容器内由 nginx 监听 `80`，宿主端口 `10019` 仅由根项目端口表或部署命令映射。

## 数据说明

数据保存在浏览器本机，不会发送到远端。IndexedDB（v2）中有两个对象存储：

- `snapshots`：唯一权威的已提交快照（当前 head 修订）。
- `pending-commits`：待提交记录。每次编码改动**先**写在这里（携带它所基于的修订号 `baseRevision`），
  随后在同一个 IndexedDB 事务内校验 head 修订、写入新快照并删除记录；任一步失败整体回滚，不产生中间态。

localStorage 里的同名键只是「浏览级快照」镜像，只在提交成功后刷新，永远不会反过来覆盖 IndexedDB。
如果浏览器在记录落盘后关闭，重开时会自动重放记录；若另一个标签页已经把修订推进，记录会保留为冲突，
界面要求研究者逐项选择「在最新修订上重放」或「放弃」，双方内容都不会被静默覆盖。
v1 版本（只有 localStorage 快照）升级时，若浏览级快照比本地数据库新，会自动从该快照恢复并写入审计记录。
