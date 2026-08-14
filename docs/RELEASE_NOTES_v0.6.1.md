# DIEM Agent Workers v0.6.1

## Fixed

- Read Upstash's raw `HGETALL` array response correctly so `/v1/stats` exposes the privacy-safe lifetime counters already stored by v0.6.0.
- Added a production-shape regression test. No prompt, output, caller, wallet, transaction, IP, user-agent, request-ID, or timestamp data is added.
