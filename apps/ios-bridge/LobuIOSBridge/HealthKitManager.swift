import Foundation
import HealthKit

@MainActor
final class HealthKitManager: ObservableObject {
    @Published private(set) var authorizationStatus = "Not requested"

    private let store = HKHealthStore()
    private let calendar = Calendar.current

    var isHealthDataAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async throws {
        guard isHealthDataAvailable else {
            throw HealthBridgeError.healthDataUnavailable
        }

        try await store.requestAuthorization(toShare: [], read: readTypes())
        authorizationStatus = "Authorized"
    }

    func summariesForLastDays(_ days: Int) async throws -> ([DailyHealthSummary], [WorkoutSummary]) {
        guard days > 0 else { return ([], []) }
        var summaries: [DailyHealthSummary] = []
        var workoutSummaries: [WorkoutSummary] = []
        for offset in stride(from: days - 1, through: 0, by: -1) {
            guard let date = calendar.date(byAdding: .day, value: -offset, to: Date()) else { continue }
            summaries.append(try await dailySummary(for: date))
            workoutSummaries.append(contentsOf: try await workouts(for: date))
        }
        return (summaries, workoutSummaries)
    }

    func dailySummary(for date: Date) async throws -> DailyHealthSummary {
        let start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else {
            throw HealthBridgeError.invalidDateRange
        }

        async let steps = cumulativeQuantity(.stepCount, unit: .count(), start: start, end: end)
        async let distance = cumulativeQuantity(.distanceWalkingRunning, unit: .meter(), start: start, end: end)
        async let activeEnergy = cumulativeQuantity(.activeEnergyBurned, unit: .kilocalorie(), start: start, end: end)
        async let exerciseMinutes = cumulativeQuantity(.appleExerciseTime, unit: .minute(), start: start, end: end)
        async let restingHeartRate = averageQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), start: start, end: end)

        return DailyHealthSummary(
            date: healthDateString(for: start, calendar: calendar),
            startAt: start,
            endAt: end,
            steps: try await steps,
            distanceMeters: try await distance,
            activeEnergyKilocalories: try await activeEnergy,
            exerciseMinutes: try await exerciseMinutes,
            restingHeartRateBpm: try await restingHeartRate
        )
    }

    func workouts(for date: Date) async throws -> [WorkoutSummary] {
        let start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else {
            throw HealthBridgeError.invalidDateRange
        }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: HKWorkoutType.workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let workouts = (samples as? [HKWorkout] ?? []).map { workout in
                    WorkoutSummary(
                        id: workout.uuid,
                        workoutType: workoutName(for: workout.workoutActivityType),
                        startAt: workout.startDate,
                        endAt: workout.endDate,
                        durationSeconds: workout.duration,
                        activeEnergyKilocalories: workout.totalEnergyBurned?.doubleValue(for: .kilocalorie()),
                        distanceMeters: workout.totalDistance?.doubleValue(for: .meter())
                    )
                }
                continuation.resume(returning: workouts)
            }
            store.execute(query)
        }
    }

    private func cumulativeQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date) async throws -> Double {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return 0 }
        return try await statistics(type: type, unit: unit, option: .cumulativeSum, start: start, end: end) ?? 0
    }

    private func averageQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date) async throws -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return nil }
        return try await statistics(type: type, unit: unit, option: .discreteAverage, start: start, end: end)
    }

    private func statistics(type: HKQuantityType, unit: HKUnit, option: HKStatisticsOptions, start: Date, end: Date) async throws -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: option) { _, result, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let quantity = option == .discreteAverage ? result?.averageQuantity() : result?.sumQuantity()
                continuation.resume(returning: quantity?.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }

    private func readTypes() -> Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKWorkoutType.workoutType()]
        [
            HKQuantityTypeIdentifier.stepCount,
            .distanceWalkingRunning,
            .activeEnergyBurned,
            .appleExerciseTime,
            .restingHeartRate,
        ].compactMap { HKQuantityType.quantityType(forIdentifier: $0) }.forEach { types.insert($0) }
        return types
    }
}

enum HealthBridgeError: LocalizedError {
    case healthDataUnavailable
    case invalidDateRange
    case missingConfiguration

    var errorDescription: String? {
        switch self {
        case .healthDataUnavailable: return "Health data is not available on this device."
        case .invalidDateRange: return "Could not build the HealthKit date range."
        case .missingConfiguration: return "Set Lobu base URL, org slug, and token before syncing."
        }
    }
}
