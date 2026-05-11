import CryptoKit
import Foundation

/// Handles `local.directory` jobs: enumerates persisted security-scoped folder
/// bookmarks, reads eligible text files, and returns WorkerStreamItems.
///
/// v1 constraints:
/// - Shallow enumeration only (no subdirectory recursion).
/// - Extensions: txt, md, json, csv, html.
/// - Max file size: 1 MB per file.
/// - Max total files: 500 across all bookmarks.
///
/// Events carry the folder's *display name* and the file name only — never the
/// absolute path (which would leak the user's home directory / disk layout into
/// Lobu). The stable origin id derives the folder part from a hash of the
/// security-scoped bookmark, so it's stable across syncs without exposing it.
enum LocalDirectorySyncService {
    private static let allowedExtensions: Set<String> = ["txt", "md", "json", "csv", "html"]
    private static let maxFileSize: Int = 1_048_576   // 1 MB
    private static let maxTotalFiles: Int = 500

    /// Opaque, stable 12-hex-char id for a folder bookmark — used in origin ids
    /// so they don't carry the path. Stable as long as the bookmark is.
    private static func folderKey(for bookmark: Data) -> String {
        SHA256.hash(data: bookmark).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    static func runLocalDirectory(job: WorkerJob) throws -> [WorkerStreamItem] {
        let bookmarks = (UserDefaults.standard.array(forKey: "lobu.localFolderBookmarks") as? [Data]) ?? []
        guard !bookmarks.isEmpty else { return [] }

        var items: [WorkerStreamItem] = []
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
        }

        return items
    }
}
