# Streaming writes and saved output

Issue: #209. VISION promises 1, 3 and 7.

The synthetic turn streams 2,000 text deltas and 300 progress updates with changing 12 KiB command output. With WAL durability set to FULL and automatic checkpointing disabled for measurement, the recorded baseline and branch runs produced:

| Write cost | Main baseline | Batched writer |
| --- | ---: | ---: |
| WAL commits | 5,801 | 301 |
| Row mutations, including triggers and FTS | 20,327 | 2,721 |
| WAL plus new output-file bytes | 238,914,712 | 18,737,720 |

The benchmark enforces budgets of 350 commits, 3,500 row mutations and 32 MiB. It includes one 12,288-byte content-addressed output file. These are fixture measurements, not device-throughput estimates. The baseline uses the original full-message progress path. The Linux CI run for commit `fe4314a` reproduced the branch numbers before the final shutdown correction and extra delivery assertions.

The captures below came from the completed browser checks through the serialized test gate before checks were paused. They use the real tool card and API client with synthetic output responses. The fixture verifies no eager output fetch, explicit pages of at most 64 KiB, exact continuation cursors and access to the final output line. It does not exercise the installed application or a live provider.

| Theme | Inline preview | First page | Final line |
| --- | --- | --- | --- |
| Light | [Preview](after-saved-output-preview-light.png) | [Page](after-saved-output-page-light.png) | [Complete](after-saved-output-full-light.png) |
| Dark | [Preview](after-saved-output-preview-dark.png) | [Page](after-saved-output-page-dark.png) | [Complete](after-saved-output-full-dark.png) |

The final local checks were skipped because the owner paused the shared test gate. Skipped checks are not passes. Review/CI must validate the final revision, including the shutdown regression and live-delivery assertions. The production service and its data were not accessed.
