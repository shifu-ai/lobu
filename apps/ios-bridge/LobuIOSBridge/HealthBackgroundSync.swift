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
                let result = try await HealthSyncService.sync(requestHealthAuthorization: false)
                print("[LobuIOSBridge] Background sync uploaded \(result.uploadedCount) Apple Health events.")
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
