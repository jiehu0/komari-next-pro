# 长时间范围 Ping 曲线断裂修复记录

## 维护索引

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-15 |
| 分支 | `fix/ping-chart-long-range-gaps` |
| 基线 | `ai` |
| 修复提交 | `25b191c02ee0473319dc04020bd926e4f248550b` |
| Pull Request | [jiehu0/komari-next-pro#1](https://github.com/jiehu0/komari-next-pro/pull/1) |
| 影响组件 | `theme/src/components/instance/PingChart.tsx` |
| 生产主题版本 | `2.0.1` |
| 状态 | 已构建、已部署、已验证 |

## 现象

网络质量页面的延迟趋势图存在以下表现：

- `24h` 曲线完整。
- `7天` 曲线出现多段断裂。
- `30天` 曲线基本不可见，只在左右边缘残留少量线段。
- 曲线不可见的位置仍能触发 tooltip，并显示正确的时间和延迟值。

这说明数据已经进入图表，故障发生在曲线连接阶段，而不是 tooltip、Agent 上报或数据库读取阶段。

## 定位结果

生产环境检查得到：

- `ping_records` 中存在完整的 30 天记录，数据库不是空的。
- `common:getRecords` 对单次响应限制为约 4000 条记录，长时间范围会被降采样。
- 按单条监控线路估算，采样间隔约为：

| 范围 | 典型采样间隔 |
| --- | ---: |
| `24h` | 约 4 分钟 |
| `7天` | 约 28 分钟 |
| `30天` | 约 117 分钟 |

`PingChart` 会先按时间合并不同任务的数据，再通过 `interpolateNullsLinear` 填补同一条线路在合并数据中的空值。修复前的配置为：

```ts
{
  maxGapMultiplier: 6,
  minCapMs: 2 * 60_000,
  maxCapMs: 30 * 60_000,
}
```

插值函数根据每条线路的中位采样间隔计算允许跨度，但最终被 `maxCapMs` 限制在 30 分钟。`7天` 数据已经接近该上限，`30天` 数据的正常采样间隔则远超上限，因此有效点之间的空值未被插值。

Recharts 使用 `connectNulls={false}`，遇到这些空值不会连接相邻点。tooltip 仍能读取孤立有效点，所以出现“有信息但没有曲线”的现象。

## 修复

只修改长时间范围图表的插值上限：

```diff
- maxCapMs: 30 * 60_000,
+ maxCapMs: hours * 60 * 60_000,
```

同时把 `hours` 加入 `chartData` 的 `useMemo` 依赖：

```diff
- }, [midData, cutPeak, tasks]);
+ }, [midData, cutPeak, tasks, hours]);
```

完整修改位于 `theme/src/components/instance/PingChart.tsx`。

## 为什么没有直接连接所有空值

`connectNulls` 仍保持 `false`，`maxGapMultiplier` 仍保持 `6`。因此允许跨度会随降采样间隔变化，但超过约 6 个正常采样周期的真实数据缺口仍会保留，不会被伪造为连续曲线。

本次修改只是移除固定 30 分钟上限对长时间范围正常采样的误伤。

## 验证

### 构建验证

在 `theme/` 目录执行：

```bash
npm ci
npm run build
```

两项均通过。构建产物中已确认包含新的动态 `maxCapMs` 逻辑。

### 数据验证

使用生产 RPC 返回的数据模拟插值：

- `24h` 保持连续。
- `7天` 的正常降采样点能够连接。
- `30天` 不再因固定 30 分钟上限而只剩孤立点。
- 超过 6 个典型采样周期的异常缺口仍保持断开。

### 上线验证

生产站点 [komari.boyweb.net](https://komari.boyweb.net/) 已返回 HTTP 200，并加载包含修复的静态 chunk。

## 打包注意事项

当前线上 `2.0.0` 包含以下手工注入脚本，但它们不会由本分支的普通源码构建自动生成：

```text
komari-mood-v21.js
komari-asset-fix.js
```

因此本次 `2.0.1` 部署包以线上官方 `2.0.0` 包为基础，替换修复后的 Next.js 构建产物，并保留上述脚本和原有主题清单。后续 Agent 不应直接用 GitHub Source ZIP 覆盖生产主题，也不应在未检查这两个脚本的情况下直接使用 `theme/build-theme.sh` 的产物上线。

本次部署包校验值：

```text
SHA256 6d585eac33d5573eee31b4c9639d913688754ad75a033cac78645b9dab61a425
```

## 部署与回滚记录

生产主题目录：

```text
/opt/komari/data/theme/komari-next-pro
```

部署前备份：

```text
/opt/komari/backups/20260715174027/
├── komari.db
└── komari-next-pro/
```

主题配置仍保存在 Komari 数据库中，部署时没有清空或重建。若需要回滚，先停止可能写入主题目录的操作，将当前主题目录移走，再把备份中的 `komari-next-pro/` 恢复到生产主题目录；数据库只有在主题配置也损坏时才需要恢复。

## 后续维护检查

修改 Ping 图表或后端记录采样策略时，至少复查以下项目：

1. `common:getRecords` 的响应上限或降采样方式是否改变。
2. `interpolateNullsLinear` 的中位间隔、倍数和上下限语义是否改变。
3. `24h`、`7天`、`30天` 三个范围是否都能显示连续的正常采样段。
4. 人为制造超过 6 个典型周期的数据缺口，确认图表仍然断开。
5. 切换范围后确认 `hours` 变化会重新计算 `chartData`。

## 关联范围

`theme/src/components/MiniPingChart.tsx` 仍使用固定 30 分钟插值上限。本次故障只发生在实例详情的网络质量图，未修改迷你图。若以后在迷你图复现相同现象，应单独验证其数据范围和采样方式后再处理，不要直接复制本次参数。
