import Foundation
import HealthKit

struct DailyHealthSummary: Codable, Equatable {
    let date: String
    let startAt: Date
    let endAt: Date
    let steps: Double
    let distanceMeters: Double
    let activeEnergyKilocalories: Double
    let exerciseMinutes: Double
    let restingHeartRateBpm: Double?

    var originID: String { "apple-health:daily:\(date)" }

    var title: String { "Health summary for \(date)" }

    var summaryText: String {
        var parts = [
            "\(Int(steps.rounded())) steps",
            "\(String(format: "%.1f", distanceMeters / 1000)) km",
            "\(Int(activeEnergyKilocalories.rounded())) kcal active energy",
            "\(Int(exerciseMinutes.rounded())) exercise minutes"
        ]
        if let restingHeartRateBpm {
            parts.append("\(Int(restingHeartRateBpm.rounded())) bpm resting heart rate")
        }
        return "On \(date): \(parts.joined(separator: ", "))."
    }
}

struct WorkoutSummary: Codable, Equatable, Identifiable {
    let id: UUID
    let workoutType: String
    let startAt: Date
    let endAt: Date
    let durationSeconds: Double
    let activeEnergyKilocalories: Double?
    let distanceMeters: Double?

    var originID: String { "apple-health:workout:\(id.uuidString.lowercased())" }

    var title: String {
        if let distanceMeters, distanceMeters > 0 {
            return "\(workoutType) — \(String(format: "%.1f", distanceMeters / 1000)) km"
        }
        return workoutType
    }

    var summaryText: String {
        var parts = ["\(workoutType) for \(Int((durationSeconds / 60).rounded())) minutes"]
        if let distanceMeters, distanceMeters > 0 {
            parts.append("\(String(format: "%.1f", distanceMeters / 1000)) km")
        }
        if let activeEnergyKilocalories, activeEnergyKilocalories > 0 {
            parts.append("\(Int(activeEnergyKilocalories.rounded())) kcal active energy")
        }
        return parts.joined(separator: ", ") + "."
    }
}

func healthDateString(for date: Date, calendar: Calendar = .current) -> String {
    let start = calendar.startOfDay(for: date)
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: start)
}

func workoutName(for activityType: HKWorkoutActivityType) -> String {
    switch activityType {
    case .running: return "Running"
    case .walking: return "Walking"
    case .cycling: return "Cycling"
    case .traditionalStrengthTraining: return "Strength training"
    case .functionalStrengthTraining: return "Functional strength training"
    case .highIntensityIntervalTraining: return "HIIT"
    case .yoga: return "Yoga"
    case .swimming: return "Swimming"
    case .hiking: return "Hiking"
    case .mindAndBody: return "Mind and body"
    case .pilates: return "Pilates"
    case .dance: return "Dance"
    case .rowing: return "Rowing"
    case .elliptical: return "Elliptical"
    default: return "Workout"
    }
}
