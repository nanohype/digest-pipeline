/**
 * Client-side Levenshtein distance for real-time edit-rate display.
 * Falls back to a sampled approximation when either input is longer
 * than 5_000 characters so we don't block the main thread on a
 * 600-word newsletter edit.
 */

export function levenshteinDistance(a: string, b: string): number {
  if (a.length > 5_000 || b.length > 5_000) return approximateDistance(a, b);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function approximateDistance(a: string, b: string): number {
  const SAMPLE = 1_000;
  const samples = [
    [a.slice(0, SAMPLE), b.slice(0, SAMPLE)],
    [
      a.slice(Math.floor(a.length / 2) - SAMPLE / 2, Math.floor(a.length / 2) + SAMPLE / 2),
      b.slice(Math.floor(b.length / 2) - SAMPLE / 2, Math.floor(b.length / 2) + SAMPLE / 2),
    ],
    [a.slice(-SAMPLE), b.slice(-SAMPLE)],
  ];
  const sampleRate =
    samples.reduce((sum, [sa, sb]) => sum + levenshteinDistance(sa, sb) / Math.max(sa.length, 1), 0) / samples.length;
  return Math.round(sampleRate * Math.max(a.length, b.length));
}
