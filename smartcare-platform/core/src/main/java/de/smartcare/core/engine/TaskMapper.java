package de.smartcare.core.engine;

import de.smartcare.core.event.Dto;
import de.smartcare.core.task.Task;

final class TaskMapper {
    private TaskMapper() {}
    static Dto.TaskDto dto(Task t) {
        return new Dto.TaskDto(t.id, t.source, t.from, t.to, t.priority.name(), t.status.name(), t.robotId, t.requester, t.requesterName,
                t.item, t.notes, t.origin, t.createdAt, t.assignedAt, t.pickedAt, t.deliveredAt, t.etaSec, t.version);
    }
}
