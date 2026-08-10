# Komari Benchmark History

Komari 1.4.2+ plugin that schedules and stores 30 days of:

- Sysbench CPU single-thread and all-thread events/s
- Sysbench sequential memory read/write MiB/s
- fio 50/50 random read/write throughput and IOPS for 4K, 64K, 512K, and 1M blocks

The schedule is `30 3 * * *` in the Komari server's local timezone. One complete run takes about 80 seconds per node. Nodes run in parallel.

## Requirements

- Komari Agent remote control enabled
- `sysbench` and `fio` installed on each tested node
- At least 768 MiB free in `/var/tmp`

The plugin never installs packages. Missing tools, disabled remote control, low disk space, and task timeouts are stored as failed points.

## API

```text
GET  /api/plugin/komari-benchmark/history?uuid=<node-uuid>
POST /api/plugin/komari-benchmark/run?uuid=<optional-node-uuid>  (admin)
GET  /api/plugin/komari-benchmark/status                       (admin)
```

Omit `uuid` from the manual run endpoint to test every node. Only one suite can run at a time.
