# LongMemEval Mode A (retrieval only) - memory-core internal harness

Repo 5ea3852 (HEAD), node v22.14.0, dataset sha256 08d8dad4be43ee20...

Restricted to the 150-question stratified subset `bench/longmemeval/work/subset-150.json`. Every system below is scored on these same questions.

## bm25
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 88.1/3/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.2883 | 0.6692 | 0.7900 | 0.8917 | 0.7297 | 0.6583 | 15.8 | 0.9750 |
| multi-session | 36 | 0.2662 | 0.5139 | 0.6736 | 0.8194 | 0.6485 | 0.5574 | 33.0 | 0.9444 |
| knowledge-update | 21 | 0.3571 | 0.8651 | 0.9048 | 1.0000 | 0.8135 | 0.7985 | 2.0 | 1.0000 |
| single-session-user | 19 | 0.6316 | 0.9474 | 1.0000 | 1.0000 | 0.7447 | 0.8064 | 2.1 | 1.0000 |
| single-session-assistant | 17 | 0.6471 | 0.7647 | 0.9412 | 0.9412 | 0.7064 | 0.7597 | 5.8 | 1.0000 |
| single-session-preference | 9 | 0.1667 | 0.2593 | 0.4630 | 0.5185 | 0.2711 | 0.3115 | 128.7 | 0.7778 |
| **overall** | 142 | 0.3741 | 0.6815 | 0.8029 | 0.8862 | 0.6917 | 0.6634 | 22.2 | 0.9648 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## memory-core
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 90.1/3/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.2958 | 0.7150 | 0.7983 | 0.9275 | 0.7200 | 0.6787 | 14.4 | 0.9750 |
| multi-session | 36 | 0.2708 | 0.5625 | 0.6944 | 0.8519 | 0.7065 | 0.5886 | 29.9 | 0.9444 |
| knowledge-update | 21 | 0.3095 | 0.8889 | 0.9524 | 1.0000 | 0.7698 | 0.7936 | 1.7 | 1.0000 |
| single-session-user | 19 | 0.5263 | 0.8421 | 0.9474 | 1.0000 | 0.6768 | 0.7390 | 2.7 | 1.0000 |
| single-session-assistant | 17 | 0.5882 | 0.7059 | 0.8824 | 0.9412 | 0.6682 | 0.7149 | 6.9 | 1.0000 |
| single-session-preference | 9 | 0.1111 | 0.4074 | 0.5185 | 0.5185 | 0.2731 | 0.3488 | 222.2 | 0.5556 |
| **overall** | 142 | 0.3457 | 0.6985 | 0.8070 | 0.9045 | 0.6836 | 0.6644 | 27.2 | 0.9507 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

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

## random
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.0000 | 0.0125 | 0.0125 | 0.0933 | 0.0193 | 0.0066 | 345.7 | 0.3250 |
| multi-session | 36 | 0.0093 | 0.0093 | 0.0093 | 0.0671 | 0.0401 | 0.0130 | 295.1 | 0.4444 |
| knowledge-update | 21 | 0.0238 | 0.0238 | 0.0238 | 0.0238 | 0.0518 | 0.0292 | 368.6 | 0.2857 |
| single-session-user | 19 | 0.0000 | 0.0000 | 0.0000 | 0.1053 | 0.0070 | 0.0000 | 380.4 | 0.2632 |
| single-session-assistant | 17 | 0.0000 | 0.0000 | 0.0000 | 0.0588 | 0.0039 | 0.0000 | 444.0 | 0.1176 |
| single-session-preference | 9 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0015 | 0.0000 | 449.2 | 0.1111 |
| **overall** | 142 | 0.0059 | 0.0094 | 0.0094 | 0.0680 | 0.0247 | 0.0095 | 359.2 | 0.3028 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## mc-enhanced
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.0550 | 0.0675 | 0.0758 | 0.1975 | 0.1729 | 0.0871 | 297.6 | 0.4250 |
| multi-session | 36 | 0.0833 | 0.1343 | 0.1481 | 0.2315 | 0.2591 | 0.1523 | 169.5 | 0.6944 |
| knowledge-update | 21 | 0.1190 | 0.2063 | 0.2460 | 0.2698 | 0.2992 | 0.2315 | 204.3 | 0.6190 |
| single-session-user | 19 | 0.1053 | 0.1579 | 0.2105 | 0.2632 | 0.1454 | 0.1551 | 274.5 | 0.4737 |
| single-session-assistant | 17 | 0.0000 | 0.0588 | 0.0588 | 0.1176 | 0.0203 | 0.0253 | 411.9 | 0.1765 |
| single-session-preference | 9 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0031 | 0.0000 | 402.9 | 0.2222 |
| **overall** | 142 | 0.0683 | 0.1117 | 0.1305 | 0.2035 | 0.1807 | 0.1212 | 268.6 | 0.4859 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## mc-dual-layer
n scored = 142 (of 150 run; 8 zero-gold excluded), mean corpus = 495 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 40 | 0.0250 | 0.4175 | 0.5850 | 0.7642 | 0.2832 | 0.3410 | 11.9 | 1.0000 |
| multi-session | 36 | 0.0139 | 0.1991 | 0.3981 | 0.6111 | 0.1809 | 0.2048 | 50.7 | 0.9167 |
| knowledge-update | 21 | 0.0714 | 0.4365 | 0.7619 | 0.8810 | 0.3556 | 0.4440 | 7.0 | 1.0000 |
| single-session-user | 19 | 0.1053 | 0.5789 | 0.6316 | 0.8421 | 0.2883 | 0.3610 | 36.9 | 0.9474 |
| single-session-assistant | 17 | 0.0588 | 0.2941 | 0.2941 | 0.4706 | 0.1603 | 0.1842 | 140.2 | 0.7647 |
| single-session-preference | 9 | 0.0556 | 0.2593 | 0.3333 | 0.3704 | 0.2404 | 0.2455 | 130.9 | 0.7778 |
| **overall** | 142 | 0.0458 | 0.3617 | 0.5192 | 0.6930 | 0.2512 | 0.2995 | 47.3 | 0.9296 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0202 R@30=0.0606 MRR=0.0193 meanRank=343.8

## Overall, all systems (same harness, same corpora)

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| bm25 | 142 | 0.3741 | 0.6815 | 0.8029 | 0.8862 | 0.6917 | 0.6634 | 22.2 | 0.9648 |
| memory-core | 142 | 0.3457 | 0.6985 | 0.8070 | 0.9045 | 0.6836 | 0.6644 | 27.2 | 0.9507 |
| memory-core-hybrid-k5 | 142 | 0.3462 | 0.7712 | 0.8716 | 0.9769 | 0.7117 | 0.7043 | 5.7 | 0.9930 |
| memory-core-hybrid-k60 | 142 | 0.3533 | 0.7525 | 0.8648 | 0.9455 | 0.7066 | 0.7010 | 6.8 | 0.9930 |
| random | 142 | 0.0059 | 0.0094 | 0.0094 | 0.0680 | 0.0247 | 0.0095 | 359.2 | 0.3028 |
| mc-enhanced | 142 | 0.0683 | 0.1117 | 0.1305 | 0.2035 | 0.1807 | 0.1212 | 268.6 | 0.4859 |
| mc-dual-layer | 142 | 0.0458 | 0.3617 | 0.5192 | 0.6930 | 0.2512 | 0.2995 | 47.3 | 0.9296 |

## Sanity checks

- random control recall@10 = 0.0094 vs analytic floor 0.0202 (3 sigma tol +/-0.0354) -> OK
- mean top-10 Jaccard(bm25, memory-core) = 0.5962
- run-time SHA per system (stamped by the worker, not the scorer): {"bm25":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"memory-core":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"memory-core-hybrid-k5":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"memory-core-hybrid-k60":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"random":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"mc-enhanced":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"mc-dual-layer":["5ea385230b8ac0066e91a9847aedecf05eebdc97"]}
- single SHA across all systems: yes
- memory-core vector liveness: 0.0% of hits vector-credited, 0/150 questions fully embedded, 150 with zero credit; reasons e.g. ["strong term match","high confidence"]
- memory-core-hybrid-k5 vector liveness: 99.5% of hits vector-credited, 150/150 questions fully embedded, 0 with zero credit; reasons e.g. ["lexical and vector match","bm25 #1","vector #2","high confidence"]
- memory-core-hybrid-k60 vector liveness: 99.7% of hits vector-credited, 150/150 questions fully embedded, 0 with zero credit; reasons e.g. ["lexical and vector match","bm25 #1","vector #2","high confidence"]
- mc-enhanced vector liveness: 0.0% of hits vector-credited, 0/150 questions fully embedded, 150 with zero credit; reasons e.g. ["high semantic similarity","high confidence","temporally relevant for temporal query","matches 1 entities: I"]
- mc-dual-layer vector liveness: 0.0% of hits vector-credited, 0/150 questions fully embedded, 150 with zero credit; reasons e.g. ["recent memory","long-term insight"]
- no flags

## Honesty note

These are OUR numbers from OUR harness on the public LongMemEval_S dataset (500 questions).
They are NOT comparable to published LongMemEval leaderboard figures: different retrieval
granularity (one memory per turn), different corpus construction, no reader model in Mode A,
and a different protocol. Do not place these next to third-party numbers as a comparison.

---

_Note: infrastructure paths and the machine hostname were rewritten to repo-relative placeholders when this artifact was imported into the public repository. No metric, denominator, git SHA, dataset hash or model id was altered._
