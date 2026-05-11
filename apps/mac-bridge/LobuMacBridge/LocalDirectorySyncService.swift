import CryptoKit
import Foundation

/// Result of a `local.directory` sync pass: the events to stream and the new
/// feed checkpoint to persist (per-folder last-sync timestamps).
struct LocalDirectoryOutput {
    let items: [WorkerStreamItem]
    /// `{"folder:<hash>": <unix seconds>}` for every folder walked this pass.
    /// Folders that no longer exist drop out (their key isn't re-added), so the
    /// checkpoint stays bounded; the server stores it verbatim.
    let checkpoint: [String: AnyEncodable]
}

/// Handles `local.directory` jobs: enumerates persisted security-scoped folder
/// bookmarks, reads eligible text files, and returns WorkerStreamItems.
///
/// v1 constraints:
/// - Shallow enumeration only (no subdirectory recursion).
/// - Extensions: txt, md, json, csv, html.
/// - Max file size: 1 MB per file.
/// - Max total files: 500 across all bookmarks.
///
/// Incremental: each folder carries a `last sync` timestamp in the feed
/// checkpoint, and a pass skips (without even reading) files whose mtime predates
/// it. A folder with no checkpoint entry — newly added, or first run — is fully
/// scanned. The stored timestamp is the pass *start* time, so a file modified
/// while a pass is running is picked up next time rather than missed. Server-side
/// dedup is by `origin_id` (`local-dir:<folderHash>:<filename>`), so a modified
/// file updates its event; a deleted file leaves its event behind (a present-id
/// reconcile that tombstones is a known follow-up).
///
/// Events carry the folder's *display name* and the file name only — never the
/// absolute path (which would leak the user's home directory / disk layout into
/// Lobu). The folder hash in `origin_id` / the checkpoint keys is opaque and
/// stable as long as the bookmark is.
enum LocalDirectorySyncService {
    private static let allowedExtensions: Set<String> = ["txt", "md", "json", "csv", "html"]
    private static let maxFileSize: Int = 1_048_576   // 1 MB
    private static let maxTotalFiles: Int = 500

    /// Opaque, stable 12-hex-char id for a folder bookmark — used in origin ids
    /// and checkpoint keys so neither carries the path. Stable as long as the
    /// bookmark is.
    private static func folderKey(for bookmark: Data) -> String {
        SHA256.hash(data: bookmark).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    static func runLocalDirectory(job: WorkerJob) throws -> LocalDirectoryOutput {
        let bookmarks = (UserDefaults.standard.array(forKey: "lobu.localFolderBookmarks") as? [Data]) ?? []
        let passStartedAt = Int(Date().timeIntervalSince1970)
        guard !bookmarks.isEmpty else { return LocalDirectoryOutput(items: [], checkpoint: [:]) }

        var items: [WorkerStreamItem] = []
        var checkpoint: [String: AnyEncodable] = [:]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fm = FileManager.default

        for bookmark in bookmarks {
            guard items.count < maxTotalFiles else { break }
            var isStale = false
            guard let folderURL = try? URL(
                resolvingBookmarkData: bookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ) else { continue }

            guard folderURL.startAccessingSecurityScopedResource() else { continue }
            defer { folderURL.stopAccessingSecurityScopedResource() }

            let folderName = folderURL.lastPathComponent
            let folderId = folderKey(for: bookmark)
            let checkpointKey = "folder:\(folderId)"
            // nil ⇒ folder never synced (or first run) ⇒ full scan.
            let syncedSince: Double? = (job.checkpoint?[checkpointKey]?.intValue).map(Double.init)

            guard let entries = try? fm.contentsOfDirectory(
                at: folderURL,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for fileURL in entries {
                guard items.count < maxTotalFiles else { break }

                // Regular files only
                guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }

                let ext = fileURL.pathExtension.lowercased()
                guard allowedExtensions.contains(ext) else { continue }

                let resources = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let fileSize = resources?.fileSize ?? 0
                guard fileSize <= maxFileSize else { continue }

                let modifiedAt = resources?.contentModificationDate ?? Date()

                // Skip files unchanged since this folder's last sync — stat only,
                // no read. Strict `<` so a same-second edit is re-synced (cheap
                // no-op upsert) rather than missed.
                if let syncedSince, modifiedAt.timeIntervalSince1970 < syncedSince { continue }

                guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { continue }

                let filename = fileURL.lastPathComponent
                let item = WorkerStreamItem(
                    id: "local-dir:\(folderId):\(filename)",
                    title: filename,
                    payload_text: text,
                    occurred_at: iso.string(from: modifiedAt),
                    semantic_type: "file_document",
                    metadata: [
                        "source": AnyEncodable("local_directory"),
                        "folder": AnyEncodable(folderName),
                        "name": AnyEncodable(filename),
                        "ext": AnyEncodable(ext),
                        "size_bytes": AnyEncodable(fileSize),
                        "modified_at": AnyEncodable(iso.string(from: modifiedAt)),
                    ]
                )
                items.append(item)
            }

            checkpoint[checkpointKey] = AnyEncodable(passStartedAt)
        }

        return LocalDirectoryOutput(items: items, checkpoint: checkpoint)
    }
}
