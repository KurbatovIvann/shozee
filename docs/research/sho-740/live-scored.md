# SHO-740 — live calls rescored

Only the first assistant step was taken, so a legitimate lookup before
a write (`catalog_list_products` before `catalog_createVariant`) scores
as a miss under exact match. The looser columns bound that effect.

| metric | arm A | arm B |
|---|---|---|
| first tool is the gold tool (commands only) | 35/70 = 50.0% | 29/70 = 41.4% |
| first tool is in the gold module | 48/70 = 68.6% | 44/70 = 62.9% |
| called nothing when nothing was asked for | 20/30 = 66.7% | 19/30 = 63.3% |
| wrong write as the first call | 0/100 = 0.0% | 0/100 = 0.0% |
| answered in text with no tool (commands only) | 6/70 = 8.6% | 13/70 = 18.6% |

| stratum | A exact | B exact | A module | B module | A wrong write | B wrong write |
|---|---|---|---|---|---|---|
| read | 19/25 = 76.0% | 17/25 = 68.0% | 22/25 = 88.0% | 20/25 = 80.0% | 0/25 = 0.0% | 0/25 = 0.0% |
| write | 11/25 = 44.0% | 10/25 = 40.0% | 16/25 = 64.0% | 16/25 = 64.0% | 0/25 = 0.0% | 0/25 = 0.0% |
| clarify | 5/20 = 25.0% | 2/20 = 10.0% | 10/20 = 50.0% | 8/20 = 40.0% | 0/20 = 0.0% | 0/20 = 0.0% |
| talk | n/a | n/a | n/a | n/a | 0/15 = 0.0% | 0/15 = 0.0% |
| unsupported | n/a | n/a | n/a | n/a | 0/15 = 0.0% | 0/15 = 0.0% |
