# infra/milvus —— 知识库向量索引（Milvus Standalone）

本目录只放**部署与运维**，不放代码。向量索引的读写实现属于 `packages/knowledge`（见
`docs/report-summary-vectordb-integration-plan.md` §4.8）。

> **定位**：Milvus 是**可重建的索引**，不是真相源。
> 知识库的唯一真相源是 SQLite（`kb_docs` / `kb_chunks` / `kb_terms`）。
> 删掉本目录下的 `volumes/`，跑一次重建任务即可完全恢复。
> 这条是整套方案的安全底线——它保证 **Milvus 挂了永远不致命**。

---

## 前置条件

| 项 | 要求 |
| --- | --- |
| Docker | Docker 19.03+ / Docker Desktop，**Docker Compose v2** |
| 内存 | Standalone **最低 8GB**，推荐 16GB。macOS 上 Docker Desktop 的 VM 必须调到 **≥2 vCPU + 8GB**，否则起不来 |
| 磁盘 | SATA 3.0 SSD 起步；**etcd 强烈建议本地 NVMe**（etcd 对 fsync 敏感，慢盘会引发频繁选举，整体退化） |
| CPU | 需支持 SSE4.2 / AVX / AVX2 之一（SIMD 指令集，向量检索与建索引依赖） |
| 端口 | `19530`（gRPC **与 RESTful 复用同一端口**）、`9091`（健康/指标），均已绑定 `127.0.0.1` |

> **实测补充（2026-10-12）**：Milvus 3.0 的 **RESTful API 在 19530**（与 gRPC 同端口复用），
> 路径形如 `POST /v2/vectordb/collections/list`；
> **9091 只有健康与指标端点**（`/healthz`、`/api/v1/health`），
> 打 `/v2/vectordb/*` 会返回 `404 page not found`。
> 这一点与网上大量"RESTful 在 9091"的旧文章不一致，别被带偏——
> 它直接决定了集成侧要不要引 gRPC 依赖（走 19530 的 REST 可以**零依赖**）。

这是本项目继 `npm run collector:setup`（Python 运行时）之后的**第二条环境前置**。

---

## 启停

```bash
cd infra/milvus

docker compose up -d                 # 启动（首次会拉镜像，约数百 MB）
docker compose ps                    # 期望：milvus-standalone / milvus-etcd / milvus-minio 均 Up
curl http://127.0.0.1:9091/healthz   # 期望输出 OK

docker compose logs -f standalone    # 排障看日志
docker compose down                  # 停止（保留数据）
```

仓库根目录有等价快捷方式：`npm run milvus:up` / `npm run milvus:down`
（以及 `npm run stack:up` 一次拉起 Milvus + 嵌入服务）。

首次启动到 healthz 返回 OK **可能需要 60–90 秒**（compose 里 `start_period: 90s` 就是为此）。

### 正常长什么样（先看这里，再判定"没启动"）

这条最容易被误判——下面四处**看起来像故障、实际正常**：

**1. `docker compose ps` 只显示 3 个容器，这是对的。**

```
NAME                STATUS
milvus-etcd         Up (healthy)
milvus-minio        Up (healthy)
milvus-standalone   Up (healthy)
```

`milvus-volume-init` 是**一次性**容器（chown 数据目录），跑完即退出，默认不显示。
加 `-a` 或在 Docker Desktop 里会看到它 `Exited (0)`——**设计如此，不是失败**；
显示 `Exited (1)` 才是问题（看它的日志）。

**2. 那条约每 0.5 秒刷屏的内存警告——已修，不会再出现。**

`[WARN] failed to get container memory limit` 曾占 standalone 日志的 **22%**。
根因：容器不设内存上限时 cgroup `memory.max` 读出来是 `max`，Milvus 读不到有效值。
已给 standalone 加 `mem_limit: 3g` 修复。

**3. 冷启动那十几秒的会话重协商风暴——正常，会自愈。**

**整容器重建**（改 compose 后 `up -d`）时，新容器会与 etcd 里残留的旧会话冲突
（日志里可见 `old session exists`），streamingnode 的 assignment discover client
进入热重试，短时间刷出大量：

```
[INFO]  swap assignment discover client
[INFO]  old assignment discover client closed
[WARN]  assignment discover client is unavailable, try to resuming...
```

实测：一次重建约 **4 万~37 万行**，集中在启动后 **15~20 秒**内，之后**完全停止**，
回到约 4 行/秒的正常心跳。**功能不受影响**（同一时刻建表/写入/检索全部正常，
`ERROR` 仅 2 条且均为启动期 RPC 超时）。

> **对照实验**：直接 `docker restart milvus-standalone`（容器不重建）只新增 **2 条**；
> 说明它由「新容器 + 已存在的 etcd 元数据」触发，**首次全新启动（etcd 为空）完全不会出现**。
> 这是 Milvus 启动期的内部行为，compose 层改不掉——能做的是**把日志封顶**：
> 三个常驻服务均已配 `max-size: 10m / max-file: 3`（单容器上限 30MB）。

**4. `9091/v2/vectordb/*` 返回 404——不是故障，是端口搞错了。**

RESTful API 在 **19530**；9091 只有 `/healthz` 与指标。另外 REST 的**业务失败也是 HTTP 200**，
必须判 body 里的 `code`。

**5. `2379` / `9000` 从宿主机连不上——故意的。**

etcd 与 MinIO 只在容器网络内互通，不向宿主机发布端口（安全收敛，见「鉴权与暴露面」）。

**先自查这五条，再下"没启动"的结论。**

### 常见问题

| 症状 | 原因与处置 |
| --- | --- |
| `standalone` 反复重启 | 多为内存不足。已加 `mem_limit: 3g` 与 `restart: unless-stopped`，OOM 会自愈；若仍反复，确认 Docker VM ≥8GB，或看 `milvus-volume-init` 日志确认数据目录属主 |
| `volume-init` 显示 Exited | `Exited (0)` 正常（一次性任务完成）；`Exited (1)` 才是问题 |
| 重启 Docker Desktop 后没起来 | 已加 `restart: unless-stopped`；若仍未起，`docker compose up -d` 手动拉起 |
| 日志突然暴涨十几万行 | 冷启动的会话重协商（见上第 3 条），十几秒后自愈；已配日志轮转封顶 30MB |
| 端口被占用 | `lsof -i :19530 -i :9091`；改 compose 里的映射（左侧宿主端口） |
| healthz 一直失败 | etcd 启动慢，等满 90 秒再判定；仍失败看 `docker compose logs etcd` |
| 磁盘 IO 告警 | etcd 数据目录换到本地 NVMe。参考官方 `prerequisite-docker.md` 的 `fio` 测试 |

---

## 鉴权与暴露面（**不要跳过**）

Standalone 默认**无鉴权**。本库装的是客户私域语料的向量（KB-2 租户私有数据），
所以 compose 里已经把端口收敛到 `127.0.0.1`，**不要**改回 `0.0.0.0` 或裸写 `"19530:19530"`。

如果部署环境还需要更强隔离：

1. 打开鉴权：在 `standalone` 服务加环境变量
   `COMMON_SECURITY_AUTHORIZATIONENABLED: "true"`，并配置 root 密码；
   同时把 `BM_MILVUS_TOKEN` 填成对应的 `username:password`。
2. 需要 MinIO 控制台排障时**临时**开端口（用完即关）：

   ```bash
   docker compose exec minio mc ready local    # 先确认 minio 活着
   # 在 compose 的 minio 服务临时加 127.0.0.1:9001:9001 后再 up -d
   ```

---

## 版本锁定

镜像 tag 在 `docker-compose.yml` 顶部的 `x-milvus-image` 里**钉死**（当前 `v3.0.2`），
**不要改成 `latest`**。理由：Milvus 与 Node SDK `@zilliz/milvus2-sdk-node` 有版本兼容矩阵
（例如 v2.5.x ↔ SDK 2.5.x），`latest` 会在某天 CI 拉到不兼容的大版本，而**失败是静默的**。

升级步骤：查官方兼容矩阵 → 改 `x-milvus-image` → `docker compose down && up -d` →
跑一致性用例 → 必要时重建索引。

---

## 数据与清理

```
volumes/milvus/    # Milvus 自身数据
volumes/etcd/      # 元数据
volumes/minio/     # 对象存储
```

- **已 gitignore，切勿提交**（客户语料的语义指纹不可入公开仓库）。
- 完全重置：`docker compose down && rm -rf volumes/`，随后触发一次索引重建。
- `down` 加 `-v` 只删 named volume；本 compose 用的是 bind mount，所以必须手动删 `volumes/`。

---

## 与网关的接线

Node 侧用官方 SDK `@zilliz/milvus2-sdk-node`，连 `http://127.0.0.1:19530`，
配置项 `BM_MILVUS_URI` / `BM_MILVUS_TOKEN` / `BM_MILVUS_COLLECTION` / `BM_MILVUS_TIMEOUT_MS`。

四条硬约束（详见方案文档 §4.8）：

1. 检索前必须 `loadCollectionSync`。
2. 搜刚写入的数据要 `consistency_level: 'Strong'`；常规检索用 `Bounded`。
3. **租户过滤必须下推到 Milvus 的 filter 表达式**——否则全局 topK 名额会被别的租户挤占，
   表现为"本租户的资料明明有却检不出来"，而且不报错。
4. **不在进程启动路径上做连接/建表**。Milvus 没起时网关必须能正常启动、正常出报告
   （语义通道静默降级为纯 BM25 并记 degraded）。
   `BM_VECTOR_DRIVER=memory` 是回滚开关，也是 CI 的默认值。
