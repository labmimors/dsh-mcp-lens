# DeepSeek V4 Flash 真模型实测

本报告记录 MCP Lens 与 DeepSeek Harness 官方直接 MCP 客户端的一组小规模真模型对比。它回答一个实际问题：渐进披露是否仍能完成真实工具任务，以及模型可见工具面和 API 用量发生了什么变化？

## 结果概览

| 三项任务合计 | 官方直接客户端 | MCP Lens | 差异 |
|---|---:|---:|---:|
| 完成任务 | 3 / 3 | 3 / 3 | 相同 |
| 每次请求中模型可见工具 | 1,025 | 27 | 减少 97.366% |
| 每次请求的 `request/header.tools` JSON | 674,249 B | 27,401 B | 减少 95.936% |
| 非缓存输入 Token | 199,751 | 21,713 | 减少 89.130% |
| 缓存命中输入 Token | 934,912 | 74,496 | 减少 92.032% |
| 输出 Token | 491 | 794 | 增加 61.711% |
| 预估 API 费用 | $0.0307204 | $0.0034707 | 降低 88.702% |

这组实测支持一个有限但实用的结论：在这三项任务和这个 1,000 工具 Fixture 中，Lens 保持了任务完成结果，同时显著减少常驻工具上下文和预估 API 费用。它不是通用任务质量或延迟 Benchmark。

## 测试设置

- 日期：2026 年 8 月 14 日
- DeepSeek Harness：`0.1.0-rc.6`
- Provider／模型：`deepseek-official/deepseek-v4-flash`
- MCP Transport：两侧使用同一个本地 stdio Server
- 远端目录：1,000 个 MCP 工具
- Lens 路径：先 `mcp_search`，再 `mcp_call`
- 直接路径：每个远端工具各注册一个模型可见 Schema

Harness 在两侧还开放了 25 个非 MCP 工具。因此完整请求中，Lens 是 27 个工具，直接客户端是 1,025 个工具；只看 MCP 组件则是两个对 1,000 个 Schema。

## 任务与实际调用

| 任务 | Lens 调用 | 直接客户端调用 | 结果 |
|---|---|---|---|
| 按邮件查找客户 | `mcp_search` → `fixture/lookup_customer_by_email` | `mcp__fixture__lookup_customer_by_email` | 两侧都正确 |
| 搜索包含“退款”的中文支持工单 | `mcp_search` → `fixture/search_support_tickets` | `mcp__fixture__search_support_tickets` | 两侧都正确 |
| 按作者列出开放 Pull Request | `mcp_search` → `fixture/github_list_pull_requests` | `mcp__fixture__github_list_pull_requests` | 两侧都正确 |

每个 Lens Session 都在调用前获取了命中工具的准确 `inputSchema`。六个 Session 都以 `completed` 结束，最终答案都与工具结果一致。

## 用量与费用计算

Provider 返回的聚合 Usage：

| 测试侧 | 非缓存输入 | 缓存命中输入 | 输出 | Reasoning |
|---|---:|---:|---:|---:|
| 官方直接客户端 | 199,751 | 934,912 | 491 | 253 |
| MCP Lens | 21,713 | 74,496 | 794 | 307 |

费用估算采用 2026 年 8 月 15 日有效的 DeepSeek V4 Flash 官方价格：

- 缓存未命中输入：每百万 Token $0.14
- 缓存命中输入：每百万 Token $0.0028
- 输出：每百万 Token $0.28

计算公式：

```text
预估费用 =
  非缓存输入 / 1,000,000 × $0.14
  + 缓存命中输入 / 1,000,000 × $0.0028
  + 输出 / 1,000,000 × $0.28
```

价格来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)。Provider 价格可能变化，之后比较时应使用记录的 Usage 和最新价格重新计算。

## 这组数据能说明什么

这是三项任务的功能性实测，不是具有统计效力的 Benchmark。它直接核验了这些案例中的真实模型、Harness 工具轨迹、Provider Usage、调用参数、工具结果和任务完成状态。

额外搜索步骤让 Lens 在这组样本中产生了更多输出 Token。因此，当目录上下文占据主要成本时——例如工具很多、Server 很多或能力大多是长尾——Lens 的价值最明显。如果只有几个稳定工具，而且几乎每轮都使用，官方直接客户端仍然更简单。

无需 API Key、可以完整复现的 12／100／1,000 工具组件 Benchmark 见 [`../benchmark/README.md`](../benchmark/README.md)。
