# EnerFlow Web App (v0.1)

一个可本地运行的“时间 + 精力管理”MVP：计划 → 执行 → 复盘。

## 1) 已实现功能

- 任务管理（能量需求/注意力类型/重要性）
- 每日精力打分（morning/noon/evening）
- 规则版自动排程（按能量窗口匹配任务）
- 执行记录（开始/结束 session，记录实际能耗与原因标签）
- 晚间复盘（加权完成率、错配次数、明日建议）

## 2) 本地运行

```bash
cd /home/adam/.openclaw/workspace/energy-webapp
npm install
npm start
```

打开：`http://localhost:8787`

## 3) 任务拆解（从0到可用）

### Phase A — 基础架构（已完成）
1. 初始化 Node/Express 项目
2. 建立 SQLite 数据库与表结构（tasks/checkins/sessions/reviews）
3. 实现 REST API 基础路由

### Phase B — 核心闭环（已完成）
1. Plan：任务创建 + 三段精力输入
2. Scheduling：规则引擎生成推荐并可应用到任务
3. Now：一键开始/结束任务，采集实际能耗
4. Review：自动生成当日复盘指标

### Phase C — 可用性（已完成）
1. 单页 Web UI（Plan/Now/Review 三个 Tab）
2. 关键操作 1~2 点击可完成
3. 健康检查与基础异常处理

## 4) API 入口

- `GET /api/v1/health`
- `GET/POST/PATCH /api/v1/tasks`
- `GET/POST /api/v1/energy-checkins`
- `POST /api/v1/sessions/start`
- `POST /api/v1/sessions/:id/end`
- `GET /api/v1/sessions`
- `POST /api/v1/schedule/generate`
- `POST /api/v1/schedule/apply`
- `GET /api/v1/review/daily`

## 5) 下一步建议（v0.2）

1. 接入 Google Calendar（会议密度自动化）
2. 引入周趋势图（错配率/高能任务完成率）
3. 优化排程算法（上下文切换成本 + 块时长动态）
4. 用户系统/JWT 与多设备同步
