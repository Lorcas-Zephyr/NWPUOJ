const fs = require('fs/promises');
const path = require('path');
let mysql;
try {
  mysql = require('mysql2/promise');
} catch (_) {
  mysql = require('/app/node_modules/mysql2/promise');
}

const sourceDir = process.argv[2] || '/tmp/xian-2014-source';
const checkerDir = process.argv[3] || '/tmp/xian-2014-checkers';
const uploadDir = '/app/uploads';

function paragraphs(...parts) {
  return parts.join('\n\n');
}

function example(input, output) {
  const block = value => value.split('\n').map(line => '    ' + line).join('\n');
  return '**Sample Input**\n\n' + block(input) + '\n\n**Sample Output**\n\n' + block(output);
}

const sourceNote = paragraphs(
  '**Source:** 2014 ACM-ICPC Asia Xi\'an Regional Contest, onsite release.',
  'The release archive does not contain official time-limit metadata. The limits below are conservative import settings.'
);

const problems = [
  {
    letter: 'A', title: 'Built with Qinghuai and Ari Factor', time: 1000,
    description: paragraphs(
      'An integer divisible by 3 is called a Qinghuai number. A sequence is said to be built with Qinghuai if every element in the sequence is a Qinghuai number.',
      'Given several integer sequences, determine whether each sequence is built with Qinghuai.'
    ),
    input: paragraphs(
      'The first line contains the number of test cases, $T$.',
      'For each test case, the first line contains an integer $n$ ($1 \\le n \\le 100$), the length of the sequence. The second line contains $n$ integers. Every input number is at most $10^6$.'
    ),
    output: 'For each test case output `Case #x: y`, where `x` starts from 1 and `y` is `Yes` if every number is divisible by 3, otherwise `No`.',
    sample: example('2\n3\n1 2 3\n2\n3000 996', 'Case #1: No\nCase #2: Yes')
  },
  {
    letter: 'B', title: 'Puzzle & Dragons', time: 10000, spj: 'puzzle',
    description: paragraphs(
      'A puzzle consists of a $5 \\times 6$ grid. Each cell contains one of six drops: Fire, Water, Plant, Light, Darkness, or Cure, represented by `F`, `W`, `P`, `L`, `D`, and `C`.',
      'Choose a starting drop and move it along a path of length at most 9. Every step is up, down, left, or right. Moving along the path cyclically shifts the drops: each drop moves to the next position and the last drop moves to the starting position.',
      'After the movement, elimination repeats until stable. Any horizontal or vertical run of at least three equal drops is removed, and drops above empty cells fall down. Adjacent or overlapping chains of the same type count as one combo.',
      'Choose a path that maximizes, in order: (1) number of combos, (2) number of eliminated drops, and (3) the negative path length. If several paths are still tied, output any one of them. The special judge validates the path and these optimization goals.'
    ),
    input: 'The first line contains $T$ ($T \\le 100$). Each test case contains 5 lines of 6 characters, each character one of `F`, `W`, `P`, `L`, `D`, `C`.',
    output: paragraphs(
      'For each test case first output `Case #x:`.',
      'Then output `Combo:a Length:b`, followed by the 1-based starting coordinates `x y`, followed by a path string of length `b` containing only `U`, `D`, `L`, `R`.'
    ),
    sample: example('1\nCFFLLW\nCPDPDC\nFLDWFD\nLFCFCD\nCDPLWL', 'Case #1:\nCombo:5 Length:9\n4 3\nRURURDLDD')
  },
  {
    letter: 'C', title: 'The Problem Needs 3D Arrays', time: 3000, spj: 'float1e6',
    description: paragraphs(
      'For a sequence $S$, let $r(S)$ be its number of inversions and $l(S)$ be its length. An inversion is a pair $(i,j)$ such that $i<j$ and $S_i>S_j$.',
      'Given a permutation $P$ of length $n$, find a subsequence $S$ maximizing $r(S)/l(S)$.'
    ),
    input: 'The first line contains $T$. For each test case, the first line contains $n$ ($1 \\le n \\le 100$), followed by a line containing a permutation of $1..n$.',
    output: 'For each test case output `Case #x: y`. The absolute error of `y` must not exceed $10^{-6}$.',
    sample: example('1\n5\n3 4 2 5 1', 'Case #1: 1.250000000000')
  },
  {
    letter: 'D', title: 'The Diameter of Tree', time: 5000, spj: 'float5e4',
    description: paragraphs(
      'A tree has been lost, but its DFS order and BFS order are known. Consider all labeled trees consistent with both orders and assume each such tree is equally likely.',
      'Compute the expected diameter, where the diameter is the maximum shortest-path distance between any two vertices.'
    ),
    input: 'The first line contains $T$. For each test case, the first line contains $n$ ($1 \\le n \\le 10000$). The next line is the DFS sequence and the following line is the BFS sequence; each contains $n$ integers.',
    output: 'For each test case output `Case #x: y`, the expected diameter. The checker accepts an absolute error up to $5 \\times 10^{-4}$.',
    sample: example('1\n7\n1 2 3 5 4 7 6\n1 2 4 6 3 5 7', 'Case #1: 4.000')
  },
  {
    letter: 'E', title: 'Brushing King', time: 5000,
    description: paragraphs(
      'Brushing King is a moving point. His sight is a circular sector with angle $\\theta$ and radius $R$. He moves at speed 1 in a given direction. At specified times he may rotate either his sight direction or movement direction clockwise.',
      'Several fixed sleeping positions are given. A position is unsafe if it lies inside or on the boundary of the sight sector at any time, including the instant of a rotation. The course ends immediately after the final action. Determine which positions remain unseen for the whole course.'
    ),
    input: paragraphs(
      'The first line contains $T$. For each test case, the first line contains $n,m,\\theta,R$ ($1 \\le n,m,R \\le 1000$, $0<\\theta<180$).',
      'The next line contains $p_x,p_y,v_x,v_y,d_x,d_y$: initial position, sight direction vector, and movement direction vector. Coordinates are between -2000 and 2000; direction-vector lengths are nonzero and at most 2000.',
      'The next $n$ lines contain sleeping positions. The next $m$ lines contain actions `p t alpha` in strictly increasing time order. `p=1` rotates the sight vector and `p=2` rotates the movement vector, both clockwise by `alpha` degrees.'
    ),
    output: 'For each test case output `Case #x:`, followed by an $n$-character binary string. Character $i$ is `1` if position $i$ is safe, otherwise `0`.',
    sample: example('1\n3 2 90 3\n0 0 0 1 0 1\n50 1\n-1 0\n-100 0\n1 1 180\n1 100 0', 'Case #1: 101')
  },
  {
    letter: 'F', title: 'Color', time: 5000,
    description: 'Color $n$ flowers in a line using exactly $k$ distinct colors selected from $m$ available colors. Adjacent flowers must have different colors. Count the number of distinct colorings.',
    input: 'The first line contains $T$ (about 300). Each test case contains $n,m,k$ with $1 \\le n,m \\le 10^9$, $1 \\le k \\le 10^6$, and $k \\le n,m$. In most cases $k$ is relatively small.',
    output: 'For each test case output `Case #x: y`, where `y` is the answer modulo $10^9+7$.',
    sample: example('2\n3 2 2\n3 2 1', 'Case #1: 2\nCase #2: 0')
  },
  {
    letter: 'G', title: 'The Problem to Slow Down You', time: 10000,
    description: paragraphs(
      'Given strings $A$ and $B$, count their common palindromic substring occurrences.',
      'More precisely, count quadruples $(p,q,s,t)$ such that $1 \\le p \\le q \\le |A|$, $1 \\le s \\le t \\le |B|$, $A[p..q]=B[s..t]$, and this common string is a palindrome. Different occurrence positions are counted separately.'
    ),
    input: 'The first line contains $T$. For each test case, one line contains $A$ and the next contains $B$. Each length is at most 200000, and the entire input file is smaller than 8 MB.',
    output: 'For each test case output `Case #x: y`, the number of common palindromic substring occurrences.',
    sample: example('3\nabacab\nabccab\nfaultydogeuniversity\nhasnopalindromeatall\nabbacabbaccab\nyoumayexpectedstrongsamplesbutnow', 'Case #1: 12\nCase #2: 20\nCase #3: 18')
  },
  {
    letter: 'H', title: 'The Problem to Make You Happy', time: 5000,
    description: paragraphs(
      'Alice and Bob play on a directed graph with one piece each. Bob starts at $x$, Alice at $y$, and Bob moves first. On a move, a player must move their own piece through one outgoing edge; a player unable to move loses.',
      'If the two pieces ever occupy the same vertex, Alice wins immediately. Both players play optimally. If the game never ends, Bob is considered the winner. Determine whether Bob wins.'
    ),
    input: 'The first line contains $T$. Each test case starts with $n,m$ ($2 \\le n \\le 100$, $1 \\le m \\le n(n-1)$), followed by $m$ directed edges and then the distinct starting vertices $x,y$. There are no self-loops or duplicate edges.',
    output: 'For each test case output `Case #x: Yes` if Bob can win or force an infinite game, otherwise output `Case #x: No`.',
    sample: example('3\n5 3\n1 2\n3 4\n4 5\n3 1\n4 3\n1 2\n2 3\n3 4\n1 2\n3 3\n1 2\n2 3\n3 1\n2 1', 'Case #1: Yes\nCase #2: No\nCase #3: Yes')
  },
  {
    letter: 'I', title: 'International Collegiate Routing Contest', time: 5000, spj: 'routing',
    description: paragraphs(
      'A routing table is a set of IPv4 subnets. A packet is sent to hop A if its destination belongs to at least one listed subnet, and to hop B otherwise.',
      'Invert this behavior by constructing the complement of the union of the listed subnets. Output a minimum-size set of pairwise suitable CIDR subnets whose union is exactly that complement. Subnets may be printed in any order.'
    ),
    input: paragraphs(
      'The first line contains $T$. For each test case, the first line contains $n$ ($0 \\le n \\le 30000$). The next $n$ lines contain subnets in `a.b.c.d/l` form, with octets in `[0,255]` and $0 \\le l \\le 32$.',
      'For `/32` the suffix must be present. For `/0` the address part is `0.0.0.0`.'
    ),
    output: 'For each test case output `Case #x:`, then the number of subnets, then those subnets in CIDR form. Any order is accepted.',
    sample: example('3\n0\n1\n0.0.0.0/1\n1\n128.0.0.0/1', 'Case #1:\n1\n0.0.0.0/0\nCase #2:\n1\n128.0.0.0/1\nCase #3:\n1\n0.0.0.0/1')
  },
  {
    letter: 'J', title: 'Unlimited Battery Works', time: 5000, spj: 'float1e6',
    description: paragraphs(
      'A rooted tree initially has one black piece on every vertex. Casting magic on vertex $i$ turns white every vertex $j$ in the subtree of $i$ whose distance from $i$ is at most $A_i$. White pieces remain white.',
      'At each step choose one of all $n$ vertices uniformly at random, even if that choice changes nothing. Stop when every piece is white. Compute the expected number of steps.'
    ),
    input: 'The first line contains $T$. For each test case, the first line contains $n$ ($1 \\le n \\le 50$), the next line contains $A_1..A_n$ ($0 \\le A_i < 50$), and the final line contains the parents of vertices $2..n$. Vertex 1 is the root.',
    output: 'For each test case output `Case #x: y`. The absolute error of `y` must not exceed $10^{-6}$.',
    sample: example('3\n6\n1 0 0 0 0 0\n1 1 1 1 1\n6\n1 0 1 0 1 0\n1 2 3 4 5\n50\n0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n1 1 1 4 3 1 2 7 6 9 6 8 10 9 13 16 15 13 18 14 15 19 22 18 24 26 27 25 27 28 25 28 30 34 34 33 34 34 33 36 36 36 37 42 42 44 43 46 48', 'Case #1: 6.000000000000\nCase #2: 11.000000000000\nCase #3: 224.960266916471')
  },
  {
    letter: 'K', title: 'Last Defence', time: 3000,
    description: paragraphs(
      'Given nonnegative integers $A$ and $B$, define $S_0=A$, $S_1=B$, and $S_i=|S_{i-1}-S_{i-2}|$ for $i \\ge 2$.',
      'Count the number of distinct values appearing in the infinite sequence $S$.'
    ),
    input: 'The first line contains $T$ (about 100000). Each test case contains $A,B$ with $0 \\le A,B \\le 10^{18}$.',
    output: 'For each test case output `Case #x: y`, the number of distinct values in the sequence.',
    sample: example('2\n7 4\n3 5', 'Case #1: 6\nCase #2: 5')
  }
];

async function buildPuzzleChecker() {
  const original = await fs.readFile(path.join(sourceDir, 'B_checker.cpp'), 'utf8');
  return [
    '#include <bits/stdc++.h>',
    '#define main pc2_main',
    '#define exit(code) throw code',
    original,
    '#undef exit',
    '#undef main',
    'int main() {',
    '  char a0[] = "spj", a1[] = "input", a2[] = "user_out";',
    '  char a3[] = "answer", a4[] = "pc2-result.xml";',
    '  char* argv[] = {a0, a1, a2, a3, a4};',
    '  try { pc2_main(5, argv); } catch (int) {}',
    '  std::ifstream result("pc2-result.xml");',
    '  std::string xml((std::istreambuf_iterator<char>(result)), std::istreambuf_iterator<char>());',
    '  bool accepted = xml.find("outcome=\\\"Yes\\\"") != std::string::npos;',
    '  std::cout << (accepted ? 100 : 0) << "\\n";',
    '  std::cerr << (accepted ? "Accepted" : "Wrong answer") << "\\n";',
    '  return 0;',
    '}'
  ].join('\n');
}

async function checkerSource(kind) {
  if (kind === 'puzzle') return buildPuzzleChecker();
  if (kind === 'float1e6') return fs.readFile(path.join(checkerDir, 'spj_float_1e6.cpp'), 'utf8');
  if (kind === 'float5e4') return fs.readFile(path.join(checkerDir, 'spj_float_5e4.cpp'), 'utf8');
  if (kind === 'routing') return fs.readFile(path.join(checkerDir, 'spj_routing.cpp'), 'utf8');
  return null;
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.SYZOJ_WEB_DB_HOST || 'mariadb',
    user: process.env.SYZOJ_WEB_DB_USERNAME || 'syzoj',
    password: process.env.SYZOJ_WEB_DB_PASSWORD || 'syzoj',
    database: process.env.SYZOJ_WEB_DB_DATABASE || 'syzoj',
    charset: 'utf8mb4'
  });

  const imported = [];
  await db.beginTransaction();
  try {
    await db.execute(
      'INSERT INTO problem_tag (name, color) VALUES (?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color)',
      ['2014 Xi\'an Regional', 'pink']
    );
    const [[tag]] = await db.execute('SELECT id FROM problem_tag WHERE name = ?', ['2014 Xi\'an Regional']);

    for (const problem of problems) {
      const hint = sourceNote + '\n\n**Imported limits:** ' + problem.time + ' ms, 512 MiB.';
      const values = [
        problem.title, problem.description, problem.input, problem.output, problem.sample, hint,
        problem.time, 512
      ];
      const [rows] = await db.execute(
        'SELECT id FROM problem WHERE title = ? AND user_id = 1 LIMIT 1',
        [problem.title]
      );
      let id;
      if (rows.length) {
        id = rows[0].id;
        await db.execute(
          'UPDATE problem SET description=?, input_format=?, output_format=?, example=?, limit_and_hint=?, time_limit=?, memory_limit=?, is_public=1, publicizer_id=1, type=\'traditional\', file_io=0 WHERE id=?',
          [problem.description, problem.input, problem.output, problem.sample, hint, problem.time, 512, id]
        );
      } else {
        const [result] = await db.execute(
          'INSERT INTO problem (title,user_id,publicizer_id,is_anonymous,description,input_format,output_format,example,limit_and_hint,time_limit,memory_limit,ac_num,submit_num,is_public,file_io,publicize_time,type) VALUES (?,1,1,0,?,?,?,?,?,?,?,0,0,1,0,NOW(),\'traditional\')',
          values
        );
        id = result.insertId;
      }

      await db.execute(
        'INSERT IGNORE INTO problem_tag_map (problem_id, tag_id) VALUES (?, ?)',
        [id, tag.id]
      );
      imported.push({ id, problem });
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }

  for (const { id, problem } of imported) {
    const destination = path.join(uploadDir, 'testdata', String(id));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(path.join(sourceDir, problem.letter + '.in'), path.join(destination, '1.in'));
    await fs.copyFile(path.join(sourceDir, problem.letter + '.out'), path.join(destination, '1.out'));
    if (problem.spj) {
      await fs.writeFile(path.join(destination, 'spj_cpp.cpp'), await checkerSource(problem.spj));
    }
    await fs.rm(path.join(uploadDir, 'testdata-archive', String(id) + '.zip'), { force: true });
    console.log(problem.letter + ' -> #' + id + ' ' + problem.title + (problem.spj ? ' [SPJ]' : ''));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
