# LongMemEval Mode A (retrieval only) - memory-core internal harness

Repo 5ea3852 (HEAD), node v22.14.0, dataset sha256 08d8dad4be43ee20...

## bm25
n scored = 479 (of 500 run; 21 zero-gold excluded), mean corpus = 493 turns, errors = 0, hits returned mean/min/max = 88.1/3/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 132 | 0.2995 | 0.6462 | 0.7662 | 0.8528 | 0.6477 | 0.6244 | 41.6 | 0.9242 |
| multi-session | 125 | 0.1785 | 0.5072 | 0.6443 | 0.7812 | 0.5433 | 0.4967 | 24.4 | 0.9600 |
| knowledge-update | 72 | 0.3056 | 0.7870 | 0.8681 | 0.9676 | 0.7272 | 0.7162 | 2.6 | 1.0000 |
| single-session-user | 64 | 0.7031 | 0.9219 | 0.9531 | 0.9688 | 0.8009 | 0.8370 | 17.2 | 0.9688 |
| single-session-assistant | 56 | 0.7321 | 0.8750 | 0.9464 | 0.9643 | 0.8013 | 0.8347 | 3.9 | 1.0000 |
| single-session-preference | 30 | 0.1167 | 0.3000 | 0.5111 | 0.6611 | 0.2502 | 0.3033 | 124.7 | 0.7667 |
| **overall** | 479 | 0.3619 | 0.6730 | 0.7797 | 0.8679 | 0.6459 | 0.6378 | 28.8 | 0.9499 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0203 R@30=0.0609 MRR=0.0187 meanRank=346.1

## memory-core
n scored = 479 (of 500 run; 21 zero-gold excluded), mean corpus = 493 turns, errors = 0, hits returned mean/min/max = 89.4/3/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 132 | 0.2980 | 0.6699 | 0.7838 | 0.8687 | 0.6347 | 0.6300 | 27.8 | 0.9545 |
| multi-session | 125 | 0.1927 | 0.5197 | 0.6948 | 0.8316 | 0.5965 | 0.5438 | 16.3 | 0.9760 |
| knowledge-update | 72 | 0.3171 | 0.8102 | 0.9190 | 0.9792 | 0.7618 | 0.7574 | 2.1 | 1.0000 |
| single-session-user | 64 | 0.5625 | 0.8906 | 0.9531 | 0.9844 | 0.7192 | 0.7751 | 10.0 | 0.9844 |
| single-session-assistant | 56 | 0.7143 | 0.8571 | 0.9286 | 0.9464 | 0.7914 | 0.8231 | 4.7 | 1.0000 |
| single-session-preference | 30 | 0.0667 | 0.3667 | 0.4944 | 0.6944 | 0.2273 | 0.2842 | 106.1 | 0.8000 |
| **overall** | 479 | 0.3429 | 0.6842 | 0.8023 | 0.8892 | 0.6479 | 0.6470 | 20.8 | 0.9666 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0203 R@30=0.0609 MRR=0.0187 meanRank=346.1

## random
n scored = 479 (of 500 run; 21 zero-gold excluded), mean corpus = 493 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 132 | 0.0000 | 0.0076 | 0.0152 | 0.0876 | 0.0184 | 0.0080 | 333.4 | 0.3561 |
| multi-session | 125 | 0.0027 | 0.0067 | 0.0133 | 0.0400 | 0.0214 | 0.0085 | 293.6 | 0.4560 |
| knowledge-update | 72 | 0.0069 | 0.0208 | 0.0208 | 0.0486 | 0.0309 | 0.0172 | 339.2 | 0.3472 |
| single-session-user | 64 | 0.0000 | 0.0156 | 0.0156 | 0.0625 | 0.0124 | 0.0099 | 411.0 | 0.1875 |
| single-session-assistant | 56 | 0.0000 | 0.0000 | 0.0000 | 0.0357 | 0.0029 | 0.0000 | 446.8 | 0.1071 |
| single-session-preference | 30 | 0.0000 | 0.0167 | 0.0167 | 0.0500 | 0.0114 | 0.0079 | 403.9 | 0.2000 |
| **overall** | 479 | 0.0017 | 0.0101 | 0.0139 | 0.0576 | 0.0180 | 0.0088 | 351.9 | 0.3194 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0203 R@30=0.0609 MRR=0.0187 meanRank=346.1

## mc-enhanced
n scored = 479 (of 500 run; 21 zero-gold excluded), mean corpus = 493 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 132 | 0.0343 | 0.0596 | 0.0874 | 0.1874 | 0.1048 | 0.0680 | 281.8 | 0.4621 |
| multi-session | 125 | 0.0483 | 0.0949 | 0.1108 | 0.1747 | 0.1614 | 0.0988 | 207.8 | 0.6160 |
| knowledge-update | 72 | 0.0764 | 0.1505 | 0.1829 | 0.2384 | 0.2193 | 0.1595 | 221.3 | 0.5833 |
| single-session-user | 64 | 0.0938 | 0.1250 | 0.1406 | 0.2031 | 0.1175 | 0.1184 | 321.4 | 0.3750 |
| single-session-assistant | 56 | 0.0893 | 0.1964 | 0.2143 | 0.2500 | 0.1302 | 0.1476 | 348.4 | 0.3036 |
| single-session-preference | 30 | 0.0000 | 0.0000 | 0.0167 | 0.0667 | 0.0101 | 0.0073 | 406.8 | 0.2000 |
| **overall** | 479 | 0.0565 | 0.1035 | 0.1254 | 0.1936 | 0.1355 | 0.1020 | 274.3 | 0.4739 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0203 R@30=0.0609 MRR=0.0187 meanRank=346.1

## mc-dual-layer
n scored = 479 (of 500 run; 21 zero-gold excluded), mean corpus = 493 turns, errors = 0, hits returned mean/min/max = 100.0/100/100 of depth 100

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| temporal-reasoning | 132 | 0.0366 | 0.3386 | 0.5131 | 0.6828 | 0.2534 | 0.2970 | 50.4 | 0.9242 |
| multi-session | 125 | 0.0227 | 0.2103 | 0.3409 | 0.5733 | 0.1863 | 0.1942 | 35.1 | 0.9600 |
| knowledge-update | 72 | 0.0625 | 0.4097 | 0.6505 | 0.8079 | 0.3251 | 0.3830 | 9.1 | 1.0000 |
| single-session-user | 64 | 0.0625 | 0.4766 | 0.6641 | 0.8438 | 0.2512 | 0.3379 | 27.9 | 0.9688 |
| single-session-assistant | 56 | 0.1250 | 0.3036 | 0.3750 | 0.5714 | 0.2122 | 0.2394 | 130.7 | 0.7679 |
| single-session-preference | 30 | 0.0167 | 0.1944 | 0.2500 | 0.4167 | 0.1304 | 0.1404 | 148.7 | 0.7333 |
| **overall** | 479 | 0.0494 | 0.3211 | 0.4764 | 0.6649 | 0.2339 | 0.2720 | 52.7 | 0.9207 |

Analytic random floor on the same corpora: R@1=0.0020 R@5=0.0101 R@10=0.0203 R@30=0.0609 MRR=0.0187 meanRank=346.1

## Overall, all systems (same harness, same corpora)

| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |
|---|---|---|---|---|---|---|---|---|---|
| bm25 | 479 | 0.3619 | 0.6730 | 0.7797 | 0.8679 | 0.6459 | 0.6378 | 28.8 | 0.9499 |
| memory-core | 479 | 0.3429 | 0.6842 | 0.8023 | 0.8892 | 0.6479 | 0.6470 | 20.8 | 0.9666 |
| random | 479 | 0.0017 | 0.0101 | 0.0139 | 0.0576 | 0.0180 | 0.0088 | 351.9 | 0.3194 |
| mc-enhanced | 479 | 0.0565 | 0.1035 | 0.1254 | 0.1936 | 0.1355 | 0.1020 | 274.3 | 0.4739 |
| mc-dual-layer | 479 | 0.0494 | 0.3211 | 0.4764 | 0.6649 | 0.2339 | 0.2720 | 52.7 | 0.9207 |

## Sanity checks

- random control recall@10 = 0.0139 vs analytic floor 0.0203 (3 sigma tol +/-0.0193) -> OK
- mean top-10 Jaccard(bm25, memory-core) = 0.5805
- run-time SHA per system (stamped by the worker, not the scorer): {"bm25":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"memory-core":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"random":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"mc-enhanced":["5ea385230b8ac0066e91a9847aedecf05eebdc97"],"mc-dual-layer":["5ea385230b8ac0066e91a9847aedecf05eebdc97"]}
- single SHA across all systems: yes
- memory-core vector liveness: 0.0% of hits vector-credited, 0/500 questions fully embedded, 500 with zero credit; reasons e.g. ["strong term match","high confidence"]
- mc-enhanced vector liveness: 0.0% of hits vector-credited, 0/500 questions fully embedded, 500 with zero credit; reasons e.g. ["high semantic similarity","high confidence","temporally relevant for temporal query","matches 1 entities: I"]
- mc-dual-layer vector liveness: 0.0% of hits vector-credited, 0/500 questions fully embedded, 500 with zero credit; reasons e.g. ["recent memory","long-term insight"]
- no flags

## Honesty note

These are OUR numbers from OUR harness on the public LongMemEval_S dataset (500 questions).
They are NOT comparable to published LongMemEval leaderboard figures: different retrieval
granularity (one memory per turn), different corpus construction, no reader model in Mode A,
and a different protocol. Do not place these next to third-party numbers as a comparison.
