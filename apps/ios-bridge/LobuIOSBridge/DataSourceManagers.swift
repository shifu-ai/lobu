import Contacts
import EventKit
import Foundation

// =============================================================================
// Data Source Manager protocol + permission model
//
// One manager per Apple framework whose data we surface as a Lobu connector.
// Each manager knows:
//   - its `capability` string (matches connector_definitions.required_capability)
//   - how to check + request its OS permission
//   - how to read its data into worker-protocol stream items
//
// ContentView shows a row per manager. HealthSyncService dispatches a claimed
// worker job to the matching manager by connector_key.
// =============================================================================

/// Permission state for a single data source, as the UI sees it.
enum DataSourcePermission: Equatable {
    case notDetermined
    case denied
    case authorized
    case unsupported

    var label: String {
        switch self {
        case .notDetermined: return "Not connected"
        case .denied: return "Denied — open Settings"
        case .authorized: return "Connected"
        case .unsupported: return "Unsupported"
        }
    }
}

/// Identity of a data source — drives the UI list and the worker capability map.
struct DataSourceDescriptor: Identifiable, Hashable {
    /// Stable identifier (matches connector_key on the server, without dotted prefix).
    let id: String
    /// User-facing name shown in the iOS UI.
    let label: String
    /// SF Symbol shown next to the label.
    let systemImage: String
    /// SwiftUI Color for the system image tint (kept here so the row UI stays trivial).
    /// Renders as a string to avoid pulling SwiftUI types into this file's surface.
    let iconTint: IconTint
    /// Capability advertised to the server on poll (matches connector_definitions.required_capability).
    let capability: String
    /// Connector key the server expects in poll responses.
    let connectorKey: String

    enum IconTint: String {
        case red, blue, orange, purple
    }
}

/// Catalog of data sources the bridge knows how to run. To add a new source:
/// (a) ship a connector definition with matching `requiredCapability`,
/// (b) add a manager that resolves permission + reads data,
/// (c) wire dispatch in HealthSyncService.run(job:).
enum DataSourceCatalog {
    static let health = DataSourceDescriptor(
        id: "health", label: "Apple Health",
        systemImage: "heart.fill", iconTint: .red,
        capability: "healthkit", connectorKey: "apple.health"
    )
    static let calendar = DataSourceDescriptor(
        id: "calendar", label: "Calendar",
        systemImage: "calendar", iconTint: .red,
        capability: "calendar", connectorKey: "apple.calendar"
    )
    static let reminders = DataSourceDescriptor(
        id: "reminders", label: "Reminders",
        systemImage: "checklist", iconTint: .orange,
        capability: "reminders", connectorKey: "apple.reminders"
    )
    static let contacts = DataSourceDescriptor(
        id: "contacts", label: "Contacts",
        systemImage: "person.crop.circle.fill", iconTint: .blue,
        capability: "contacts", connectorKey: "apple.contacts"
    )

    static let all: [DataSourceDescriptor] = [health, calendar, reminders, contacts]
}

// =============================================================================
// Calendar
// =============================================================================

@MainActor
final class CalendarManager: ObservableObject {
    @Published private(set) var permission: DataSourcePermission = .notDetermined

    private let store = EKEventStore()

    init() { permission = currentPermission() }

    func refreshPermission() {
        permission = currentPermission()
    }

    private func currentPermission() -> DataSourcePermission {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        case .authorized, .fullAccess: return .authorized
        case .writeOnly: return .denied  // we need read access; writeOnly is insufficient
        @unknown default: return .notDetermined
        }
    }

    func requestAuthorization() async throws {
        if #available(iOS 17.0, *) {
            _ = try await store.requestFullAccessToEvents()
        } else {
            _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                store.requestAccess(to: .event) { granted, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: granted) }
                }
            }
        }
        refreshPermission()
    }

    func eventsBetween(start: Date, end: Date) -> [EKEvent] {
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate)
    }
}

// =============================================================================
// Reminders
// =============================================================================

@MainActor
final class RemindersManager: ObservableObject {
    @Published private(set) var permission: DataSourcePermission = .notDetermined

    private let store = EKEventStore()

    init() { permission = currentPermission() }

    func refreshPermission() {
        permission = currentPermission()
    }

    private func currentPermission() -> DataSourcePermission {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        switch status {
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        case .authorized, .fullAccess: return .authorized
        case .writeOnly: return .denied
        @unknown default: return .notDetermined
        }
    }

    func requestAuthorization() async throws {
        if #available(iOS 17.0, *) {
            _ = try await store.requestFullAccessToReminders()
        } else {
            _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                store.requestAccess(to: .reminder) { granted, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: granted) }
                }
            }
        }
        refreshPermission()
    }

    /// Returns all reminders. `includeCompleted=false` filters out completed
    /// reminders post-fetch (EventKit's `predicateForReminders` returns both).
    func fetchAllReminders(includeCompleted: Bool) async throws -> [EKReminder] {
        let predicate = store.predicateForReminders(in: nil)
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[EKReminder], Error>) in
            store.fetchReminders(matching: predicate) { reminders in
                let result = reminders ?? []
                if includeCompleted {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(returning: result.filter { !$0.isCompleted })
                }
            }
        }
    }
}

// =============================================================================
// Contacts
// =============================================================================

@MainActor
final class ContactsManager: ObservableObject {
    @Published private(set) var permission: DataSourcePermission = .notDetermined

    private let store = CNContactStore()

    init() { permission = currentPermission() }

    func refreshPermission() {
        permission = currentPermission()
    }

    private func currentPermission() -> DataSourcePermission {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        switch status {
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        case .authorized: return .authorized
        case .limited: return .authorized // partial access still lets us iterate granted contacts
        @unknown default: return .notDetermined
        }
    }

    func requestAuthorization() async throws {
        _ = try await store.requestAccess(for: .contacts)
        refreshPermission()
    }

    func fetchAllContacts(includeNoName: Bool) throws -> [CNContact] {
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactIdentifierKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        var contacts: [CNContact] = []
        try store.enumerateContacts(with: request) { contact, _ in
            if !includeNoName, contact.givenName.isEmpty && contact.familyName.isEmpty {
                return
            }
            contacts.append(contact)
        }
        return contacts
    }
}
