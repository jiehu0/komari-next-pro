# Komari Benchmark History

Komari 1.4.2+ plugin that schedules and stores 30 days of:

- Geekbench 5.5.1 single-core and multi-core scores with the public result URL
- Sysbench CPU single-thread and all-thread events/s
- Sysbench sequential memory read/write MiB/s
- fio 50/50 random read/write throughput and IOPS for 4K, 64K, 512K, and 1M blocks

Each test has its own persisted schedule. The default schedules use the Komari server's local timezone:

| Test | Default |
| --- | --- |
| Sysbench CPU | Daily at 03:30 |
| Memory | Daily at 03:45 |
| fio | Sunday at 04:00 |
| Geekbench 5 | Daily at 03:00 |

Schedules can be disabled or changed to daily, weekly, or monthly from the theme's benchmark panel while signed in as an administrator. Nodes run in parallel; different test types run sequentially.

Scheduled Geekbench 5 runs sample each node's CPU usage for five seconds immediately before the benchmark. Nodes at or above 60% CPU are recorded as skipped and are not retried until the next scheduled day. Manual Geekbench runs bypass this guard.

## Requirements

- Komari Agent remote control enabled
- `sysbench` and `fio` installed on each tested node
- At least 768 MiB free in `/var/tmp`
- `curl` or `wget`, `sha256sum`, `tar`, outbound IPv4 access to the Geekbench CDN, and internet access to Geekbench Browser for GB5

The plugin never installs packages. Geekbench 5.5.1 is downloaded from the official Primate Labs CDN, checked against a pinned SHA-256 checksum, and cached under `/var/tmp/komari-geekbench5-5.5.1`. Missing tools, disabled remote control, low disk space, and task timeouts are stored as failed points.

## API

```text
GET  /api/plugin/komari-benchmark/history?uuid=<node-uuid>
POST /api/plugin/komari-benchmark/run?uuid=<optional>&test=<optional> (admin)
GET  /api/plugin/komari-benchmark/status                            (admin)
GET  /api/plugin/komari-benchmark/config                            (admin)
POST /api/plugin/komari-benchmark/config                            (admin)
```

`test` accepts `sysbench`, `memory`, `fio`, `geekbench5`, or `all` (the default). Omit `uuid` to test every node. Only one suite can run at a time.
