package de.smartcare.core.kpi;

import de.smartcare.core.event.Dto;
import de.smartcare.core.task.Task;

import java.util.*;

/** Key performance indicators computed from completed tasks (real time, no scaling). */
public final class KpiService {
    public static final String METHODOLOGY = "v1: end-to-end = delivered − created; rates over trailing 60 min; saved = 8 min per delivery";
    private static final double MANUAL_MIN_PER_TASK = 8;
    private static final Map<String, Double> SLA_MIN = Map.of("STAT", 10.0, "URGENT", 20.0, "ROUTINE", 45.0);

    private final double handoverS;
    private final Deque<Dto.KpiPoint> series = new ArrayDeque<>();
    private final long startedAt;

    public KpiService(double handoverS, long now) { this.handoverS = handoverS; this.startedAt = now; }

    public Dto.KpiLive compute(Collection<Task> tasks, long now) {
        List<Task> done = new ArrayList<>();
        for (Task t : tasks) if (t.status == Task.Status.DELIVERED && t.deliveredAt != null) done.add(t);
        long hourAgo = now - 3_600_000L, twoHoursAgo = now - 7_200_000L;
        List<Task> recent = done.stream().filter(t -> t.deliveredAt >= hourAgo).toList();
        List<Task> prev = done.stream().filter(t -> t.deliveredAt < hourAgo && t.deliveredAt >= twoHoursAgo).toList();
        List<Task> basis = recent.isEmpty() ? done : recent;
        double avg = mean(basis, Task::seconds), p90 = percentile(basis, 0.9);
        double elapsedH = Math.max(120_000, Math.min(3_600_000L, now - startedAt)) / 3_600_000.0;
        double tph = recent.size() / elapsedH;
        long inSla = basis.stream().filter(t -> t.seconds() / 60.0 <= SLA_MIN.get(t.priority.name())).count();
        double sla = basis.isEmpty() ? 1 : (double) inSla / basis.size();
        Map<String, List<Task>> by = new TreeMap<>();
        for (Task t : basis) by.computeIfAbsent(t.to, k -> new ArrayList<>()).add(t);
        List<Dto.ByStation> st = new ArrayList<>();
        by.forEach((k, v) -> st.add(new Dto.ByStation(k, v.size(), mean(v, Task::seconds))));
        double wait = mean(basis, t -> t.assignedAt == null ? 0 : (t.assignedAt - t.createdAt) / 1000.0);
        double toPick = mean(basis, t -> t.assignedAt == null || t.pickedAt == null ? 0 : (t.pickedAt - t.assignedAt) / 1000.0);
        double transit = mean(basis, t -> t.pickedAt == null ? 0 : (t.deliveredAt - t.pickedAt) / 1000.0);
        double saved = done.size() * MANUAL_MIN_PER_TASK;
        Dto.KpiPoint pt = new Dto.KpiPoint(now, r1(avg), r1(p90), r1(tph), r1(saved), r1(wait), r1(toPick), r1(transit), handoverS);
        return new Dto.KpiLive(r1(avg), r1(p90), r1(tph), r1(saved), Math.round(sla * 1000) / 1000.0,
                new Dto.Prev(prev.isEmpty() ? null : r1(mean(prev, Task::seconds)), prev.isEmpty() ? null : (double) prev.size()),
                st, now, METHODOLOGY, pt);
    }

    /** Called about every 10 s to build the trend lines. */
    public void sample(Dto.KpiPoint p) { series.addLast(p); while (series.size() > 4000) series.removeFirst(); }

    public List<Dto.KpiPoint> series(String window, long now) {
        long from = switch (window == null ? "HOUR" : window) { case "SHORT" -> now - 15 * 60_000L; case "HOUR" -> now - 60 * 60_000L; default -> 0; };
        return series.stream().filter(p -> p.t() >= from).toList();
    }

    private interface Val { double of(Task t); }
    private static double mean(List<Task> l, Val v) { return l.isEmpty() ? 0 : l.stream().mapToDouble(v::of).average().orElse(0); }
    private static double percentile(List<Task> l, double p) {
        if (l.isEmpty()) return 0;
        double[] a = l.stream().mapToDouble(Task::seconds).sorted().toArray();
        return a[(int) Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
    }
    private static double r1(double v) { return Math.round(v * 10) / 10.0; }
}
