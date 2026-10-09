package de.smartcare.core.dispatch;

import java.util.Arrays;

/** Optimal assignment (Kuhn–Munkres, O(n^2 m)) for a rows ≤ cols cost matrix. */
public final class Hungarian {
    private Hungarian() {}

    /** @return for each row the assigned column. Requires rows ≤ cols; use large finite numbers for forbidden pairs. */
    public static int[] solve(double[][] cost) {
        int n = cost.length;
        if (n == 0) return new int[0];
        int m = cost[0].length;
        if (n > m) throw new IllegalArgumentException("rows must be <= cols");
        double[] u = new double[n + 1], v = new double[m + 1];
        int[] p = new int[m + 1], way = new int[m + 1];
        for (int i = 1; i <= n; i++) {
            p[0] = i;
            int j0 = 0;
            double[] minv = new double[m + 1];
            Arrays.fill(minv, Double.MAX_VALUE);
            boolean[] used = new boolean[m + 1];
            do {
                used[j0] = true;
                int i0 = p[j0], j1 = 0;
                double delta = Double.MAX_VALUE;
                for (int j = 1; j <= m; j++) {
                    if (used[j]) continue;
                    double cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                    if (minv[j] < delta) { delta = minv[j]; j1 = j; }
                }
                for (int j = 0; j <= m; j++) {
                    if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
                }
                j0 = j1;
            } while (p[j0] != 0);
            do { int j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 != 0);
        }
        int[] ans = new int[n];
        for (int j = 1; j <= m; j++) if (p[j] != 0) ans[p[j] - 1] = j - 1;
        return ans;
    }
}
