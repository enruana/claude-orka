# Story worksheet — fill this before the first line of code

Copy it into the chat (or the folder's notes) and fill every line. Blank lines mean the story is not
ready. Show it to the user; build only after a yes.

## 1. The question the figure answers

One sentence a newcomer would ask: _"What happens to a note between the agent writing it and the model
learning from it?"_

## 2. The cast (what a dot is)

| thing | how many on stage | real count | the subsets that behave differently (prefixes of the id range) |
|---|---|---|---|
| e.g. notes | 40 | 3.3 M | 12 changed since yesterday → 8 with behaviour before → 6 not junk → 2 with an ending |

## 3. The owners (who the things belong to), if any

| territory | meaning | how many on stage | can a thing change it? how? |
|---|---|---|---|
| e.g. scorable | enough behaviour, no ending yet | 8 | an ending arrives → labeled |

## 4. The stage (places, left to right in the order things visit them)

| place | kind (box · machine · exit · output) | what is written on it | the rule it applies (machines only) |
|---|---|---|---|
| e.g. the api | box | THE API · NOTES | — |
| e.g. 1 · filter contacts | machine | queue · checking · passed | ≥ 10 events of ≥ 2 kinds in the 90 days before the note |
| e.g. the bin | exit | three reasons, one per line | — |

## 5. The steps (6 to 10)

For each step: a label, the caption (two or three sentences, in the order things will be seen), the
"now" line with the counts, where every subset is at the end, who moves and why, and what the console
shows. A step without a move is allowed only if the console shows something new.

| # | clock | label | caption | now | who moves → where, why | console |
|---|---|---|---|---|---|---|
| 1 | day 1 · 08:00 | in the api | … | 40 notes | nobody; the halo points at eight rows | the table as it is: eight rows + "and 32 more" |
| 2 | 14:00 | the copy lands | … | 40 copied | all → the lake | the load lines, ✓ each |
| 3 | 14:05 | the watermark | … | 12 changed · 28 seen | tones only | each candidate vs the watermark; three "already seen" + "25 more" |
| 4 | 14:10 | 1 · filter | … | 12 · 8 pass · 4 fall | 12 line up; each through the slot; lookup line to its owner; pass → passed, fall → bin | one row per item with the rule's numbers and ✓/✗ |
| 5 | … | 2 · the junk rules | … | … | hand-over to the second block | … |
| 6 | … | 3 · the reader | … | … | each into the reading slot; found → output; none → bin | the card: text typing, scan, fields, verdict, tokens, cost |
| 7 | … | the result meets its owner | … | … | token back to the owner; owner → new territory with a tag | one row per owner: result + what it had + ✓ |
| 8 | once | beyond one day | … | … | tones only | backfill rows; version-change rows |

## 6. Behind the ⓘ (explanations, not story)

- cadences (when what runs, what comes out)
- the contract (idempotency, watermark, caps, what is never done)
- the tables / schemas touched
- cost and what is counted
- the rules the machines apply, in full

## 7. Folds at the end

- status: decided · assumed · open (with dates, no names)
- asks outside the team
- version history

## 8. Facts

| number shown | real or illustrative | source |
|---|---|---|
