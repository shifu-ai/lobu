import BackgroundTasks
import Foundation

enum HealthBackgroundSync {
    static let identifier = "ai.lobu.IOSBridge.health-sync"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
            print("[LobuIOSBridge] Scheduled background Health sync.")
        } catch {
            print("[LobuIOSBridge] Could not schedule background Health sync: \(error.localizedDescription)")
        }
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let syncTask = Task { @MainActor in
            do {
                // Background workers can't prompt for permissions, so we only
                // advertise capabilities the user has already authorized in
                // the foreground. The dispatcher routes whichever connector
                // run the server hands back.
                let managers = DataSourceManagers(
                    health: HealthKitManager(),
                    calendar: CalendarManager(),
                    reminders: RemindersManager(),
                    contacts: ContactsManager()
                )
                let result = try await HealthSyncService.sync(managers: managers)
                print("[LobuIOSBridge] Background sync streamed \(result.uploadedCount) events from \(result.claimedConnectorKey ?? "<none>").")
                task.setTaskCompleted(success: true)
            } catch {
                print("[LobuIOSBridge] Background sync failed: \(error.localizedDescription)")
                task.setTaskCompleted(success: false)
            }
        }
        task.expirationHandler = {
            syncTask.cancel()
        }
    }
}
