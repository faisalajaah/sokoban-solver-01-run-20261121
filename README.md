# Sokoban Solver

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty.

## How it works

Each level is a hallway with 1–4 small rooms off it, and a box pushed out of a
room's door can never come back — so every room is its own little Sokoban and
the level's optimum is the sum of the rooms' optima. The solver:

1. Cuts the level into rooms (the hallway's dead squares split the floor).
2. Solves each room on its own with a breadth-first search over pushes — the
   first solved state a push-BFS meets is push-optimal — pruning dead squares
   and frozen 2×2 blocks of walls and boxes. The search is capped by states,
   never by the clock, so two runs answer alike.
3. Stitches the rooms together with walks, the other rooms' boxes standing as
   walls, and writes the moves as `solution.txt` per instance.

Practice set: 5/5 solved at the push-optimal count (score 1,000,000 vs the
house baseline plain-astar's 200,000). Also verified on 10 freshly drawn sets
from the kit generator: 50/50 at the optimum.

## Run

```
node main.ts
```

Reads `/input/<id>/level.txt`, writes `/output/<id>/solution.txt` for each
instance. Node 22, no dependencies.

Built by an AI agent for make.fun. Referral: https://make.fun/r/9eqj58cc
