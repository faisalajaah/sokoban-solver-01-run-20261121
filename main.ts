// Sokoban solver for make.fun's sokoban-solver-01: push-optimal, room by room.
//
// The generator builds each level as a hallway with 1-4 small rooms off it, and a box
// pushed out of a room's door can never come back, so every room is its own little
// Sokoban and the level's optimum is the sum of the rooms' optima. This entry solves
// each room on its own with a breadth-first search over pushes (the first solved state
// a push-BFS meets is push-optimal), then stitches the rooms together with walks.
// A room search prunes two dead ends a box can never leave: a dead square (no push,
// ignoring the other boxes, ever brings a box from it to a goal) and a frozen 2x2
// block of walls and boxes with a box off its goal. The search is capped by states,
// never by the clock, so two runs answer alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: [dx, dy, the step's letter, the push's letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** The most states one push search keeps before it gives up: work, never the clock. */
const MAX_STATES = 250_000;
/** The second try a room gets, when the first gives up and the run still has work to spare. */
const RETRY_STATES = 1_000_000;
/** The most states the whole run spends on retries, so one hard room cannot eat the wall. */
const RETRY_BUDGET = 4_000_000;
/** States spent so far, counted by work, never by the clock. */
let workSpent = 0;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** An XSB level text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box alone can be pushed from onto some goal (pulled back from the goals over open floor). */
function liveSquares(bd: Board): Uint8Array {
  const { w, wall, goals } = bd;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way, marked in `seen`
 * under `stamp`; answers the lowest square of that region, which names it.
 */
function regionLow(bd: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = bd;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(bd: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = bd;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(bd: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = bd;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

type Solved = { pushes: number; moves: string; endPlayer: number };

/**
 * The push-optimal solution of `bd`, searching at most `maxStates` states, or null when it
 * gives up. A state is the boxes' squares and the player's reachable region (named by its
 * lowest square); states are expanded in order of pushes made, so the first solved state
 * met is push-optimal. Dead squares and frozen 2x2 blocks are pruned; neither prunes a
 * solvable state, so the optimum stands.
 */
function solvePushes(bd: Board, maxStates: number): Solved | null {
  const { w, wall, goals } = bd;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(bd);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (bd.boxes.some((b) => !live[b])) return null;

  // A state's key: its region's lowest square and the boxes' squares. Numeric while the
  // board and box count keep it exact (rooms: up to 4 boxes); a string key past that.
  const big = bd.boxes.length > 5;
  const keyOf = (bs: number[], low: number): number | string => {
    if (big) return low + ':' + bs.join(',');
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  const boxes0 = bd.boxes.slice().sort((a, b) => a - b);
  const sBoxes: number[][] = [boxes0];
  const sPlayer: number[] = [bd.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of boxes0) occupied[b] = 1;
  index.set(keyOf(boxes0, regionLow(bd, occupied, bd.player, seen, ++stamp, stack)), 0);
  for (const b of boxes0) occupied[b] = 0;
  let found = solved(boxes0) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    regionLow(bd, occupied, sPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(bd, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          key = keyOf(next, regionLow(bd, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          workSpent += sBoxes.length;
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next!);
        sPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  workSpent += sBoxes.length;
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = bd.player;
  let boxes = boxes0;
  for (const s of path) {
    const nb = sBoxes[s]!;
    const from = boxes.find((b) => !nb.includes(b))!;
    const to = nb.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(bd, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nb;
  }
  return { pushes: path.length, moves, endPlayer: player };
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done?: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there
 * reaches no goal) out of the floor, and each part left that holds a box is a room.
 * Null when some part holds more or fewer boxes than goals, or a box starts in the
 * hallway: then the level is no set of rooms.
 */
function roomsOf(bd: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = bd;
  const live = liveSquares(bd);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done), the player
 * walking on from where the last room left it. A box never leaves its room, so the rooms'
 * optima add up to the level's. Falls back to a search over the whole level when the
 * level is no set of rooms, or a room's search gives up; an empty answer when that does.
 */
function solveLevel(bd: Board): string {
  const rooms = roomsOf(bd);
  if (rooms !== null) {
    let player = bd.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = bd.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
      }
      const sub: Board = {
        w: bd.w,
        h: bd.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const r = solvePushes(sub, MAX_STATES);
      if (r === null) {
        // One room over the cap is usually a tie-break away from the reference search,
        // not unsolvable: one bigger try, while the run still has work to spare.
        const retry = workSpent < RETRY_BUDGET ? solvePushes(sub, RETRY_STATES) : null;
        if (retry === null) {
          ok = false;
          break;
        }
        moves += retry.moves;
        player = retry.endPlayer;
        room.done = true;
        continue;
      }
      moves += r.moves;
      player = r.endPlayer;
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = solvePushes(bd, MAX_STATES);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
