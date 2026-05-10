import Contacts
import EventKit
import Foundation

/// Result of running one worker-loop iteration. Surfaced to the UI.
struct HealthSyncResult: Equatable {
    let dailySummaryCount: Int
    let workoutCount: Int
    let uploadedCount: Int
    /// True when the poll claimed a job. False means the server had no
    /// pending runs for any connector this device can run.
    let claimedJob: Bool
    /// The connector key of the claimed job, e.g. "apple.health". nil when
    /// no job was claimed.
    let claimedConnectorKey: String?
}

/// Bag of data-source managers the dispatcher can reach. Keeps the function
/// signature stable as we add connectors.
@MainActor
struct DataSourceManagers {
    let health: HealthKitManager
    let calendar: CalendarManager
    let reminders: RemindersManager
    let contacts: ContactsManager

    /// Capabilities to advertise on poll. Only authorized sources are listed
    /// — if the user revokes a permission, the server stops handing this
    /// device runs for that connector on the next poll.
    var advertisedCapabilities: [String: Bool] {
        var caps: [String: Bool] = [:]
        if health.authorizationStatus == "Connected" || UserDefaults.standard.bool(forKey: "healthAuthorizationRequested") {
            caps["healthkit"] = true
        }
        if calendar.permission == .authorized { caps["calendar"] = true }
        if reminders.permission == .authorized { caps["reminders"] = true }
        if contacts.permission == .authorized { caps["contacts"] = true }
        return caps
    }
}

@MainActor
enum HealthSyncService {
    /// Run one cycle of the worker protocol: poll → if claimed, dispatch
    /// based on connector_key → stream events → complete.
    static func sync(
        managers: DataSourceManagers,
        backfillDays requestedBackfillDays: Int? = nil
    ) async throws -> HealthSyncResult {
        let credentialStore = KeychainCredentialStore()
        guard var credentials = credentialStore.load() else {
            throw HealthBridgeError.missingConfiguration
        }

        let oauth = try OAuthClient(baseURL: credentials.baseURL)
        if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
            credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
            try credentialStore.save(credentials)
        }

        let worker = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        let workerId = LobuWorkerIdentity.current()

        let (job, _) = try await worker.poll(
            workerId: workerId,
            capabilities: managers.advertisedCapabilities
        )
        guard let job else {
            return HealthSyncResult(
                dailySummaryCount: 0, workoutCount: 0, uploadedCount: 0,
                claimedJob: false, claimedConnectorKey: nil
            )
        }

        do {
            let outcome = try await runJob(job: job, managers: managers, defaultBackfillDays: clampedBackfillDays(requestedBackfillDays))
            if !outcome.items.isEmpty {
                try await worker.stream(runId: job.run_id, items: outcome.items)
            }
            try await worker.complete(
                workerId: workerId,
                runId: job.run_id,
                itemsCollected: outcome.items.count,
                error: nil
            )
            return HealthSyncResult(
                dailySummaryCount: outcome.dailyCount,
                workoutCount: outcome.workoutCount,
                uploadedCount: outcome.items.count,
                claimedJob: true,
                claimedConnectorKey: job.connector_key
            )
        } catch {
            try? await worker.complete(
                workerId: workerId,
                runId: job.run_id,
                itemsCollected: 0,
                error: error.localizedDescription
            )
            throw error
        }
    }

    static func clampedBackfillDays(_ requestedBackfillDays: Int? = nil) -> Int {
        let value = requestedBackfillDays ?? UserDefaults.standard.integer(forKey: "backfillDays")
        // Upper bound matches the apple_*.ts connector schemas (3650 = 10y).
        // Lower bound at 1; fall back to "Last year" when unset.
        return min(max(value == 0 ? 365 : value, 1), 3650)
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    private struct JobOutcome {
        let items: [WorkerStreamItem]
        let dailyCount: Int
        let workoutCount: Int
    }

    private static func runJob(
        job: WorkerJob,
        managers: DataSourceManagers,
        defaultBackfillDays: Int
    ) async throws -> JobOutcome {
        switch job.connector_key {
        case "apple.health":
            return try await runHealth(job: job, manager: managers.health, defaultBackfillDays: defaultBackfillDays)
        case "apple.calendar":
            return try await runCalendar(job: job, manager: managers.calendar, defaultBackfillDays: defaultBackfillDays)
        case "apple.reminders":
            return try await runReminders(job: job, manager: managers.reminders)
        case "apple.contacts":
            return try runContacts(job: job, manager: managers.contacts)
        default:
            throw HealthBridgeError.unsupportedConnector(job.connector_key)
        }
    }

    private static func runHealth(
        job: WorkerJob,
        manager: HealthKitManager,
        defaultBackfillDays: Int
    ) async throws -> JobOutcome {
        let backfillDays = job.config?["backfill_days"]?.intValue ?? defaultBackfillDays
        let (summaries, workouts) = try await manager.summariesForLastDays(backfillDays)
        switch job.feed_key {
        case "daily_summaries":
            let items = summaries.map(dailySummaryItem(from:))
            return JobOutcome(items: items, dailyCount: summaries.count, workoutCount: 0)
        case "workouts":
            let items = workouts.map(workoutItem(from:))
            return JobOutcome(items: items, dailyCount: 0, workoutCount: workouts.count)
        default:
            let items = summaries.map(dailySummaryItem(from:)) + workouts.map(workoutItem(from:))
            return JobOutcome(items: items, dailyCount: summaries.count, workoutCount: workouts.count)
        }
    }

    private static func runCalendar(
        job: WorkerJob,
        manager: CalendarManager,
        defaultBackfillDays: Int
    ) async throws -> JobOutcome {
        let backfillDays = job.config?["backfill_days"]?.intValue ?? defaultBackfillDays
        let lookaheadDays = job.config?["lookahead_days"]?.intValue ?? 30
        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -backfillDays, to: now) ?? now
        let end = Calendar.current.date(byAdding: .day, value: lookaheadDays, to: now) ?? now
        let events = manager.eventsBetween(start: start, end: end)
        let items = events.map(calendarEventItem(from:))
        return JobOutcome(items: items, dailyCount: 0, workoutCount: 0)
    }

    private static func runReminders(
        job: WorkerJob,
        manager: RemindersManager
    ) async throws -> JobOutcome {
        let includeCompleted = (job.config?["include_completed"]?.intValue ?? 1) != 0
        let reminders = try await manager.fetchAllReminders(includeCompleted: includeCompleted)
        let items = reminders.map(reminderItem(from:))
        return JobOutcome(items: items, dailyCount: 0, workoutCount: 0)
    }

    private static func runContacts(
        job: WorkerJob,
        manager: ContactsManager
    ) throws -> JobOutcome {
        let includeNoName = (job.config?["include_no_name"]?.intValue ?? 0) != 0
        let contacts = try manager.fetchAllContacts(includeNoName: includeNoName)
        let items = contacts.map(contactItem(from:))
        return JobOutcome(items: items, dailyCount: 0, workoutCount: 0)
    }
}

// =============================================================================
// Per-connector → WorkerStreamItem mapping.
// Field names + semantic_type must match the connector definitions in
// packages/connectors/src/apple_*.ts.
// =============================================================================

private func dailySummaryItem(from summary: DailyHealthSummary) -> WorkerStreamItem {
    WorkerStreamItem(
        id: summary.originID,
        title: summary.title,
        payload_text: summary.summaryText,
        occurred_at: isoString(summary.startAt),
        semantic_type: "health_daily_summary",
        metadata: [
            "source": AnyEncodable("apple_health"),
            "origin_id": AnyEncodable(summary.originID),
            "date": AnyEncodable(summary.date),
            "steps": AnyEncodable(summary.steps),
            "distance_m": AnyEncodable(summary.distanceMeters),
            "active_energy_kcal": AnyEncodable(summary.activeEnergyKilocalories),
            "exercise_minutes": AnyEncodable(summary.exerciseMinutes),
            "resting_heart_rate_bpm": AnyEncodable(summary.restingHeartRateBpm as Any?),
        ]
    )
}

private func workoutItem(from workout: WorkoutSummary) -> WorkerStreamItem {
    WorkerStreamItem(
        id: workout.originID,
        title: workout.title,
        payload_text: workout.summaryText,
        occurred_at: isoString(workout.startAt),
        semantic_type: "health_workout",
        metadata: [
            "source": AnyEncodable("apple_health"),
            "origin_id": AnyEncodable(workout.originID),
            "workout_type": AnyEncodable(workout.workoutType),
            "duration_s": AnyEncodable(workout.durationSeconds),
            "active_energy_kcal": AnyEncodable(workout.activeEnergyKilocalories as Any?),
            "distance_m": AnyEncodable(workout.distanceMeters as Any?),
        ]
    )
}

private func calendarEventItem(from event: EKEvent) -> WorkerStreamItem {
    let originId = "apple-calendar:\(event.eventIdentifier ?? UUID().uuidString)"
    let calendarName = event.calendar?.title
    let participants = (event.attendees ?? []).compactMap { $0.name }
    let summary = [
        event.title ?? "Untitled event",
        event.location.flatMap { $0.isEmpty ? nil : "at \($0)" } ?? "",
    ].filter { !$0.isEmpty }.joined(separator: " ")
    return WorkerStreamItem(
        id: originId,
        title: event.title,
        payload_text: summary,
        occurred_at: isoString(event.startDate),
        semantic_type: "calendar_event",
        metadata: [
            "source": AnyEncodable("apple_calendar"),
            "origin_id": AnyEncodable(originId),
            "calendar_name": AnyEncodable(calendarName as Any?),
            "start_at": AnyEncodable(isoString(event.startDate)),
            "end_at": AnyEncodable(event.endDate.map(isoString) as Any?),
            "location": AnyEncodable(event.location as Any?),
            "all_day": AnyEncodable(event.isAllDay),
            "participants": AnyEncodable(participants),
        ]
    )
}

private func reminderItem(from reminder: EKReminder) -> WorkerStreamItem {
    let originId = "apple-reminders:\(reminder.calendarItemIdentifier)"
    let dueComponents = reminder.dueDateComponents
    let dueDate = dueComponents?.date
    let listName = reminder.calendar?.title
    let title = reminder.title ?? "Untitled reminder"
    let summary = [
        title,
        dueDate.map { "due \(isoString($0))" } ?? "",
        reminder.isCompleted ? "completed" : "open",
    ].filter { !$0.isEmpty }.joined(separator: " · ")
    return WorkerStreamItem(
        id: originId,
        title: title,
        payload_text: summary,
        occurred_at: isoString(reminder.completionDate ?? dueDate ?? Date()),
        semantic_type: "reminder",
        metadata: [
            "source": AnyEncodable("apple_reminders"),
            "origin_id": AnyEncodable(originId),
            "list_name": AnyEncodable(listName as Any?),
            "due_date": AnyEncodable(dueDate.map(isoString) as Any?),
            "completed": AnyEncodable(reminder.isCompleted),
            "completed_at": AnyEncodable(reminder.completionDate.map(isoString) as Any?),
            "priority": AnyEncodable(reminder.priority),
            "notes": AnyEncodable(reminder.notes as Any?),
        ]
    )
}

private func contactItem(from contact: CNContact) -> WorkerStreamItem {
    let originId = "apple-contacts:\(contact.identifier)"
    let fullName = CNContactFormatter.string(from: contact, style: .fullName) ?? ""
    let primaryEmail = (contact.emailAddresses.first?.value as String?) ?? nil
    let primaryPhone = contact.phoneNumbers.first?.value.stringValue
    let organization = contact.organizationName.isEmpty ? nil : contact.organizationName
    return WorkerStreamItem(
        id: originId,
        title: fullName.isEmpty ? "Contact" : fullName,
        payload_text: [fullName, organization ?? "", primaryEmail ?? "", primaryPhone ?? ""].filter { !$0.isEmpty }.joined(separator: " · "),
        occurred_at: isoString(Date()),
        semantic_type: "contact",
        metadata: [
            "source": AnyEncodable("apple_contacts"),
            "origin_id": AnyEncodable(originId),
            "full_name": AnyEncodable(fullName.isEmpty ? nil as Any? : fullName),
            "given_name": AnyEncodable(contact.givenName.isEmpty ? nil as Any? : contact.givenName),
            "family_name": AnyEncodable(contact.familyName.isEmpty ? nil as Any? : contact.familyName),
            "organization": AnyEncodable(organization as Any?),
            "primary_email": AnyEncodable(primaryEmail as Any?),
            "primary_phone": AnyEncodable(primaryPhone as Any?),
        ]
    )
}
