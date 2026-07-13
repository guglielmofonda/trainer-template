# Compound warm-ups

The trainer never sends a big compound straight into working reps. Exercises with
a `warmup` policy receive movement-specific ramp sets before the opening single
or working load, and Hevy receives those sets with `type: "warmup"`.

## The default ramp

| Profile | Set 1 | Set 2 | Set 3 |
|---|---:|---:|---:|
| Squat / bench / press | empty bar × 8 | 60% of target × 5 | 80% of target × 3 |
| Deadlift | 75 lb × 8 | 60% of target × 3 | 80% of target × 2 |
| Romanian deadlift | empty bar × 8 | 60% of target × 3 | 80% of target × 2 |

`target` means the heaviest thing that comes next: the opening single when the
session uses one, otherwise the working load. Loads are rounded to plates,
duplicate steps are removed, and no warm-up can equal or exceed the target.
Warm-up sets are rehearsal: fast reps, comfortably shy of fatigue, and excluded
from working-set volume, calibration, and weekly progression.

This is calibrated to the reference athlete's observed habit as well as the
research. Typical marked ramps: squat 45 lb × 8 → 95 lb × 5, deadlift 75 lb × 8 →
125 lb × 8, overhead press 45 lb × 15 → 65 lb × 10, and squat or
bench 45 lb × 8 → 90–95 lb × 8. The app preserves those starting loads
and progressive jumps while deliberately reducing repetitions as weight rises
so the ramp does not steal from work sets.

## Evidence boundary

- A broad warm-up meta-analysis found improved performance in most outcomes it
  examined, but protocols varied substantially: Fradkin, Zazryn & Smoliga
  (2010), [doi:10.1519/JSC.0b013e3181c643a0](https://pubmed.ncbi.nlm.nih.gov/19996770/).
- A systematic review found strong evidence that high-load dynamic upper-body
  warm-ups can improve strength and power. It found no eligible studies proving
  upper-body injury prevention, so the trainer does not make that claim: McCrary,
  Ackermann & Halaki (2015),
  [doi:10.1136/bjsports-2014-094228](https://pubmed.ncbi.nlm.nih.gov/25694615/).
- In resistance-trained men, squat and bench performance favored a specific
  warm-up that reached a higher load; bench responded best to progressive sets
  at 40% and 80% of the training load: Ribeiro et al. (2020),
  [doi:10.3390/ijerph17186882](https://pubmed.ncbi.nlm.nih.gov/32971729/).
- A small 2024 crossover study found that 5 reps at 80% of the initial workout
  load outperformed higher-repetition, lower-load warm-ups for subsequent
  training volume: Viveiros et al. (2024),
  [doi:10.1016/j.jbmt.2024.08.004](https://pubmed.ncbi.nlm.nih.gov/39593476/).

The exact 8 → 5 → 3 and 5 → 3 → 2 ramps are a conservative coaching translation
of that evidence plus the reference athlete's logs, not a claim that one universal sequence has
been proven optimal. If a warm-up feels tiring, reps should come down; if the
movement still feels unready, add a small load step rather than grinding reps.
