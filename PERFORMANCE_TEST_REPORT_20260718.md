# Website Performance Test Report

Test date: 2026-07-18

## Environment

- Host CPU exposed to containers: 48 logical CPUs.
- Host memory visible to containers: 377.6 GiB.
- Baseline deployment: 1 `judge-daemon` and 1 `judge-runner-1`.
- Parallel evaluator deployment: 16 `judge-daemon` and 16 `judge-runner-1` instances.
- RabbitMQ task consumers during parallel evaluation: 16.
- Local HTTP endpoint: `http://127.0.0.1`.
- All generated accounts, contests, problems, submissions and testdata were temporary.

## Public Access

The test used a weighted mix of `/`, `/help`, `/problems?repository=main`, `/contests`, `/ranklist`, `/problem/1` and the problem search API. Each level ran for 20 seconds.

| Concurrent clients | Requests | Success | Errors | P50 | P95 | P99 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3005 | 3005 (100%) | 0 | 536 ms | 1.31 s | 1.50 s | 2.20 s |
| 500 | 3404 | 3404 (100%) | 0 | 2.54 s | 6.76 s | 7.85 s | 8.04 s |
| 1000 | 3699 | 3069 (82.9%) | 630 timeout | 5.62 s | 10.00 s | 10.01 s | 10.02 s |

The 1000-client test did not produce HTTP 5xx responses. The failures were client-side 10-second request timeouts, indicating queueing or database contention rather than immediate process crashes.

## Authenticated Access

One temporary authenticated session was used to exercise authenticated problem, submissions, ranklist, contest and search pages at 1000 concurrent clients for 20 seconds.

| Concurrent clients | Requests | Success | Errors | P50 | P95 | P99 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 2370 | 480 (20.3%) | 1890 timeout | 10.00 s | 10.32 s | 10.35 s | 10.36 s |

Authenticated pages are substantially more expensive because they load user state, permissions, identity data, submission context and related database records.

## Login Burst

This is a separate test from authenticated page access. It created 500 temporary accounts and sent 500 independent `POST /api/login` requests at the same time, using valid bcrypt passwords and separate usernames.

| Concurrent logins | Requests | Success | Errors | P50 | P95 | P99 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 500 | 0 | 500 client timeout | 15.02 s | 15.04 s | 15.04 s | 15.04 s |

During the burst, Web CPU reached approximately 105%, MariaDB approximately 10%, and Web remained healthy without a restart. The client timeout does not cancel server-side bcrypt work, so the site remained slow for a short recovery period after the load generator stopped. The temporary accounts were deleted after the test.

### Login Optimization Comparison

The login path was then changed to use a 16-worker `worker_threads` bcrypt pool. The bcrypt cost remains 11; only the CPU location changed from the Web main thread to bounded workers.

| Implementation | Requests | Success | P50 | P95 | P99 | Max | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main-thread `bcryptjs` | 500 | 0 | 15.02 s | 15.04 s | 15.04 s | 15.04 s | client timeout |
| 16-worker bcrypt pool | 500 | 500 | 3.69 s | 6.21 s | 6.45 s | 6.52 s | 6.77 s |

The worker pool removed the main-thread event-loop stall and allowed all 500 logins to complete. The remaining multi-second latency includes database user lookup and concurrent Session file creation, so this is not equivalent to unlimited login throughput.

## Concurrent Submissions

The parallel evaluator configuration used 16 Daemons and 16 Runners. A local A+B problem received 1000 simultaneous normal submissions from a temporary account.

- Submitted rows: 1000.
- Submission IDs: `133-1132`.
- Final status: 1000 `Accepted`, 0 compile errors, 0 unknown, 0 pending.
- Submission timestamps: `1784349949-1784349951`.
- Reported execution time: 175-379 ms.
- RabbitMQ task queue after completion: 0 ready, 0 unacknowledged, 16 consumers.
- The client-side 300-second wait expired before the last poll completed, but all database submissions subsequently finished successfully.

## Extreme 10-Second Timeout

A traditional problem with a 10000 ms limit received 1000 simultaneous infinite-loop submissions under the same 16 Daemon/16 Runner configuration.

- Submitted rows: 1000.
- Submission IDs: `1133-2132`.
- Final status: 1000 `Time Limit Exceeded`.
- `Unknown`: 0.
- `System Error`: 0.
- Submission timestamps: `1784350473-1784350475`.
- Reported execution time: 10001-10033 ms.
- Progress observations: 496 complete initially, 807 after 180 seconds, and 1000 after a further 150 seconds.
- Approximate queue drain time: 10.5 minutes.
- RabbitMQ task queue after completion: 0 ready, 0 unacknowledged, 16 consumers.

This is consistent with approximately `1000 * 10 / 16 = 625` seconds of evaluator work, plus scheduling and process overhead.

## 1000-Participant Same-Contest Burst

This test used 1000 independent accounts in one temporary ACM contest. After login, every account simultaneously requested the contest page, the contest problem page, the ranklist and the submission list, then submitted the same 3-second problem with 50 test points.

| Phase | Requests | Success | Errors | P50 | P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Login | 1000 | 1000 | 0 | 6.90 s | 11.91 s |
| Contest/problem/ranklist/submission pages | 4000 | 197 | 3803 timeout | 30.08 s | 30.12 s |
| Contest submissions | 1000 | 0 | 1000 timeout | 30.03 s | 30.07 s |

The Web process logged repeated `contest.js` errors reading `score_details` from an undefined player object. During the burst, the Node heap grew to approximately 4 GiB and the Web process terminated with `FATAL ERROR: Reached heap limit`; Docker restarted it once. No submissions reached the judge queue in this run, so this phase is a Web contest-path failure, not an evaluator failure.

The temporary contest, 1000 participants, problem, testdata and any generated rows were removed immediately after the test. The site was restarted and returned to `healthy`.

### Remediation Verification

After the contest read path and standings update path were fixed, the same 1000 temporary accounts ran the actual participant workflow in order: login, open the contest, open the 3-second/50-test-point problem, submit, and wait for the result. The deployment still used 16 Daemons and 16 Runners.

| Phase | Requests | Success | Errors | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Login | 1000 | 1000 | 0 | 7.09 s | 12.07 s | 12.61 s |
| Contest then problem pages | 2000 | 2000 | 0 | 5.00 s | 10.53 s | 10.77 s |
| Contest submissions | 1000 | 1000 | 0 | 4.75 s | 5.36 s | 5.50 s |
| Final results | 1000 | 1000 Accepted | 0 | 207.55 s | 410.61 s | 434.23 s |

- Web restart count remained 0 and no heap/OOM failure occurred.
- All 1000 `contest_player` rows were updated and the ranklist contained 1000 valid players.
- RabbitMQ finished with 0 ready and 0 unacknowledged messages and 16 consumers.
- Web memory returned to approximately 436 MiB after the run.
- The optional extended page burst (contest, problem, ranklist and submissions all opened simultaneously) improved from 197/4000 to 2842/4000 successful requests within 30 seconds. It remains a synthetic saturation test rather than the default participant workflow.

### Independent Extreme Rerun

An independent rerun created a new marked fixture with 1000 accounts, complete identity profiles, one ACM contest, 1000 pre-registered players and a new traditional problem with a 3000 ms limit and 50 test cases. The actual participant workflow and the extended page burst were run separately so judge throughput and page saturation could be measured without conflating their request sets.

| Main workflow phase | Requests | Success | Errors | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Login | 1000 | 1000 | 0 | 7.08 s | 12.10 s | 12.65 s |
| Contest then problem pages | 2000 | 2000 | 0 | 4.46 s | 8.42 s | 8.45 s |
| Contest submissions | 1000 | 1000 | 0 | 4.39 s | 4.58 s | 4.85 s |
| Final results | 1000 | 1000 Accepted | 0 | 221.84 s | 427.83 s | 448.93 s |

| Extended burst phase | Requests | Success | Errors | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Login | 1000 | 1000 | 0 | 6.76 s | 11.72 s | 12.32 s |
| Contest/problem/ranklist/submission pages | 4000 | 4000 | 0 | 5.33 s | 12.18 s | 13.17 s |

The extended page result supersedes the earlier 2842/4000 observation: all 4000 requests completed successfully with a 60-second client timeout, and the slowest response completed in 13.17 seconds.

After the contest phases, a 60-second mixed-site test ran 100 public and 100 authenticated clients at the same time:

| Traffic group | Requests | Success | Errors | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Public weighted mix | 1299 | 1299 | 0 | 6.66 s | 9.08 s | 9.70 s |
| Authenticated weighted mix | 1207 | 1207 | 0 | 7.38 s | 9.03 s | 9.79 s |

- Main-workflow sampled Web memory peaked at approximately 656 MiB; RabbitMQ peaked at approximately 572 MiB.
- The extended 4000-page burst sampled Web memory at approximately 1.26 GiB. It fell to approximately 449 MiB after the workload and garbage collection, without restarting the process.
- The mixed public/authenticated load sampled Web memory at approximately 759 MiB. MariaDB kept 50 pooled connections with 0-1 observed active queries.
- All 1000 submission IDs and task IDs were unique. Every `contest_player` row had a positive score and an Accepted score detail.
- Web, MariaDB, Redis, RabbitMQ, all Daemons and all Runners remained running with no OOM event or new restart. One Runner's cumulative restart count of 6 was from 2026-07-15, before this rerun.
- RabbitMQ finished with 0 ready, 0 unacknowledged and 16 consumers. Relevant Web and judge logs contained no fatal, OOM, unhandled, no-testdata, system-error or judgement-failed entries.
- Cleanup removed the marked contest, problem, 1000 users, 1000 submissions, 2002 authenticated sessions and all 50 test cases. Post-cleanup counts returned to 7 users, 4 contests, 11084 problems and 0 pending submissions.

## Resource Observations

- Web remained `healthy` with `RestartCount=0` throughout the tests.
- At 1000 public clients, Web request latency reached the 10-second client timeout and MariaDB CPU was observed around 20%.
- During the initial 1000-account login burst, Web became visibly slow because bcrypt verification, session creation and identity/profile queries were concentrated on the Web and database layers.
- During the extreme timeout batch, the sampled Runner used approximately one CPU core continuously; MariaDB was low after the initial submission burst.
- RabbitMQ showed 16 task consumers with the parallel configuration.
- After cleanup, Web returned to approximately 0-2% CPU, MariaDB was idle, the queue was empty, and `/help` returned HTTP 200 in 28-124 ms.

## Findings

1. The evaluator scales correctly when Daemons and Runners are both replicated. The 1000 normal submissions all completed successfully and 1000 long-running submissions were drained without unknown or system errors.
2. The current website tier is the bottleneck at 500-1000 concurrent page requests. Latency grows sharply before the evaluator is saturated.
3. The original 1000-participant same-contest path had a correctness and memory-safety issue. The remediation verification completed the actual 1000-participant workflow without an undefined player access, restart or OOM.
4. Authenticated traffic is much more expensive than public traffic. The login burst and authenticated page mix should be isolated from public page traffic in future tests.
5. The login endpoint is a separate bottleneck: 500 simultaneous bcrypt logins exceeded the 15-second client timeout before the worker-pool optimization, while the optimized path completed all 500.
6. One Runner is strictly serial because its RabbitMQ consumer uses `prefetch(1)`. A parallel deployment requires matching Daemon and Runner replicas.
7. Contest submissions now skip standings work before judge enqueue. Completed results are serialized per contest, update only the affected player, and coalesce full ranklist rebuilds after the burst.

## Recommended Next Steps

- Keep 16 Daemon/Runner replicas only when the server is dedicated to judging; otherwise start with 8 and compare CPU, memory and queue latency.
- Add a reverse proxy or connection-level admission limit before the Web process reaches the 500-1000 concurrent range.
- Profile and cache authenticated page queries, especially problem lists, contest lists and identity/permission loading.
- Keep contest ranklist and submission-list pagination bounded; the verified defaults are 25 ranklist rows and 20 contest submissions per page.
- Add request cancellation/backpressure and a per-contest admission limit so disconnected clients cannot retain thousands of expensive render operations.
- Use a separate login-burst test with a controlled account pool; do not mix bcrypt login cost into evaluator throughput results.
- Add a persistent Compose scaling configuration instead of relying only on runtime `--scale` flags if 16 replicas are intended for production.

## Final Runtime State

After cleanup, the runtime was left at the tested parallel scale of 16 Daemons and 16 Runners. RabbitMQ reported 16 task consumers with an empty task queue. Web remained healthy with zero restarts.

## Raw Results

Complete per-request JSON files are stored in `/tmp/opencode/` on the test host:

- `site-public-100.json`
- `site-public-500.json`
- `site-public-1000.json`
- `site-auth-1000.json`
- `site-login-500.json`
- `site-login-500-workerpool.json`
- `contest-1000-full.json`
- `contest-1000-complete-after-fix.json`
- `contest_extreme_full_20260718_retry.json`
- `contest_extreme_pages_20260718_retry.json`
- `site_mixed_public_20260718_retry.json`
- `site_mixed_authenticated_20260718_retry.json`

The submission results are additionally recorded by the database ranges and status queries above because the polling client reached its 300-second client-side limit while the Runner queue continued processing normally.
