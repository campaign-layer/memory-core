# LongMemEval Mode A (retrieval only) - memory-core internal harness

Repo 5ea3852 (HEAD), node v22.14.0, dataset sha256 08d8dad4be43ee20...

Restricted to the 150-question stratified subset `bench/longmemeval/work/subset-150.json`. Every system below is scored on these same questions.

## memory-core-hybrid-k5
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.2917 | 0.7567 | 0.8233 | 0.9492 | 0.6946 | 0.6832 | 14.3 | 0.9750 |
| multi-session | 36 | 0.3194 | 0.6829 | 0.8009 | 0.9745 | 0.7999 | 0.6901 | 2.1 | 1.0000 |
| knowledge-update | 21 | 0.2857 | 0.8889 | 0.9524 | 1.0000 | 0.7556 | 0.7750 | 1.7 | 1.0000 |
| single-session-user | 19 | 0.5789 | 0.8947 | 1.0000 | 1.0000 | 0.7239 | 0.7909 | 2.2 | 1.0000 |
| single-session-assistant | 17 | 0.3529 | 0.7647 | 1.0000 | 1.0000 | 0.5808 | 0.6816 | 3.0 | 1.0000 |
| single-session-preference | 9 | 0.3333 | 0.6667 | 0.6667 | 0.9630 | 0.5542 | 0.5496 | 4.6 | 1.0000 |
| **overall** | 142 | 0.3462 | 0.7712 | 0.8716 | 0.9769 | 0.7117 | 0.7043 | 5.7 | 0.9930 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## memory-core-hybrid-k60
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.2917 | 0.7233 | 0.8492 | 0.9442 | 0.6942 | 0.6915 | 14.4 | 0.9750 |
| multi-session | 36 | 0.3194 | 0.6829 | 0.8102 | 0.8935 | 0.7895 | 0.6909 | 3.4 | 1.0000 |
| knowledge-update | 21 | 0.2857 | 0.8413 | 0.9524 | 1.0000 | 0.7397 | 0.7598 | 1.8 | 1.0000 |
| single-session-user | 19 | 0.6316 | 0.9474 | 1.0000 | 1.0000 | 0.7544 | 0.8147 | 1.9 | 1.0000 |
| single-session-assistant | 17 | 0.3529 | 0.7647 | 0.9412 | 1.0000 | 0.5769 | 0.6620 | 3.4 | 1.0000 |
| single-session-preference | 9 | 0.3333 | 0.5185 | 0.5185 | 0.8148 | 0.4977 | 0.4793 | 15.0 | 1.0000 |
| **overall** | 142 | 0.3533 | 0.7525 | 0.8648 | 0.9455 | 0.7066 | 0.7010 | 6.8 | 0.9930 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## Overall, all systems (same harness, same corpora)

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| memory-core-hybrid-k5 | 142 | 0.3462 | 0.7712 | 0.8716 | 0.9769 | 0.7117 | 0.7043 | 5.7 | 0.9930 |
| memory-core-hybrid-k60 | 142 | 0.3533 | 0.7525 | 0.8648 | 0.9455 | 0.7066 | 0.7010 | 6.8 | 0.9930 |

## Sanity checks

- run-time SHA per system (stamped by the worker, not the scorer): {"memory-core-hybrid-k5":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"memory-core-hybrid-k60":["5ea385230b8ac0066e91a9847aedecf05eebdc97"]}
- single SHA across all systems: yes
- memory-core-hybrid-k5 vector liveness: 99.5% of hits vector-credited, 150/150 questions fully embedded, 0 with zero credit; reasons e.g. ["lexical and vector match","bm25 #1","vector #2","high confidence"]
- memory-core-hybrid-k60 vector liveness: 99.7% of hits vector-credited, 150/150 questions fully embedded, 0 with zero credit; reasons e.g. ["lexical and vector match","bm25 #1","vector #2","high confidence"]
- no flags

## Honesty note

These are OUR numbers from OUR harness on the public LongMemEval_S dataset (500 questions).
They are NOT comparable to published LongMemEval leaderboard figures: different retrieval
granularity (one memory per turn), different corpus construction, no reader model in Mode A,
and a different protocol. Do not place these next to third-party numbers as a comparison.

---

_Note: infrastructure paths and the machine hostname were rewritten to repo-relative placeholders when this artifact was imported into the public repository. No metric, denominator, git SHA, dataset hash or model id was altered._
