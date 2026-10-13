import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Production JSC/SQLite Board commands in the existing physical XCTest target.
final class NativeBoardMoveTests: XCTestCase {
    private var directory: URL!, bundle: URL!, service: String!, namespace: String!
    private var database: URL { directory.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let identity = UUID().uuidString.lowercased()
        directory = support.appendingPathComponent("NativeBoardMoveTests/" + identity)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Board fixture root unavailable") }
        defer { free(physical) }; directory = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("device"), withIntermediateDirectories: true)
        bundle = directory.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        service = "mindwtr.native-keychain.fixture." + identity
        namespace = "mindwtr.board.fixture." + identity
    }

    override func tearDownWithError() throws {
        if let directory { try FileManager.default.removeItem(at: directory) }
    }

    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (directory.appendingPathComponent("device"), namespace))
        addTeardownBlock { await core.close() }; return core
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    private func storedTask(_ id: String) throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM tasks WHERE id = ?",
            parametersJSON: json([id])).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }

    private func calendarPreferenceSettings() throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT data FROM settings WHERE id = 1").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
    }

    private func expectFailure(_ contains: String? = nil, _ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected failure") }
        catch { if let contains { XCTAssertTrue(error.localizedDescription.contains(contains), error.localizedDescription) } }
    }

    private func capture(_ core: CoreHost, title: String, id: String) async throws -> String {
        let opened = try object(await core.call("captureOpen"))
        return try json([json(["text": title, "options": XCTUnwrap(opened["options"]), "captureId": id, "openAfterSave": false])])
    }

    private func seedBoardActionFixture() async throws -> String {
        let writer = host(), id = UUID().uuidString.lowercased()
        _ = try await writer.start()
        _ = try await writer.call("captureSubmit", argumentsJSON: capture(writer, title: "Destination task", id: id))
        await writer.close()
        let sqlite = try SQLiteBridge(url: database), at = "2026-01-01T12:00:00.000Z"
        defer { sqlite.close() }
        _ = try sqlite.execute("INSERT OR IGNORE INTO areas (id, name, orderNum, createdAt, updatedAt, rev) VALUES (?, ?, ?, ?, ?, ?)",
            parametersJSON: json(["destination-area-a", "Alpha area", 0, at, at, 1]))
        for (project, title, status) in [("destination-project-a", "Alpha project", "active"),
                                        ("destination-project-archived", "Archived project", "archived")] {
            _ = try sqlite.execute("INSERT OR IGNORE INTO projects (id, title, status, color, areaId, isSequential, isFocused, createdAt, updatedAt, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                parametersJSON: json([project, title, status, "#94a3b8", "destination-area-a", 0, 0, at, at, 1]))
        }
        _ = try sqlite.execute("INSERT OR IGNORE INTO sections (id, projectId, title, orderNum, isCollapsed, createdAt, updatedAt, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            parametersJSON: json(["destination-section-a", "destination-project-a", "Alpha section", 0, 0, at, at, 1]))
        _ = try sqlite.execute("UPDATE tasks SET status = 'next', projectId = ?, sectionId = ?, areaId = NULL, description = ?, dueDate = ?, startTime = ?, checklist = ?, attachments = ?, tags = ?, contexts = ?, priority = ?, energyLevel = ?, timeEstimate = ?, orderNum = ?, boardOrder = ? WHERE id = ?",
            parametersJSON: json(["destination-project-a", "destination-section-a", "Keep destination note", "2036-10-02", "2036-10-01T14:30:00.000Z",
                json([["id": "old-step", "title": "Retained step", "isCompleted": true]]),
                json([["id": "old-link", "kind": "link", "title": "Retained link", "uri": "https://example.invalid/retained", "createdAt": at, "updatedAt": at],
                      ["id": "old-file", "kind": "file", "title": "Retained file", "uri": "file:///retained", "createdAt": at, "updatedAt": at]]),
                json(["#keep"]), json(["@desk"]), "high", "low", "15min", 37, 1024, id]))
        _ = try sqlite.execute("INSERT INTO tasks (id, title, status, projectId, tags, contexts, isFocusedToday, showFutureRecurrence, suppressMindwtrReminders, pushCount, createdAt, updatedAt, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            parametersJSON: json([id + "-protected", "Protected destination", "reference", "destination-project-archived", "[]", "[]", 0, 0, 0, 0, at, at, 1]))
        sqlite.close()
        // Reuse actual core serialization before comparing protected raw cells.
        let canonicalizer = host()
        _ = try await canonicalizer.start()
        _ = try await canonicalizer.call("captureSubmit", argumentsJSON: capture(canonicalizer,
            title: "Unrelated Board row", id: UUID().uuidString.lowercased()))
        await canonicalizer.close()
        return id
    }

    private func boardMovePayload(_ core: CoreHost, taskID: String, status: String,
                                  requestID: String = UUID().uuidString.lowercased()) async throws -> String {
        let view = try object(await core.call("menuRead", argumentsJSON: json(["board", json(["limit": 100])])))
        let columns = try XCTUnwrap(view["columns"] as? [[String: Any]])
        let cards = columns.flatMap { $0["cards"] as? [[String: Any]] ?? [] }
        let item = try XCTUnwrap(cards.first { ($0["row"] as? [String: Any])?["id"] as? String == taskID })
        XCTAssertEqual(item["moveAllowed"] as? Bool, true)
        let row = try XCTUnwrap(item["row"] as? [String: Any])
        return try json([json(["requestId": requestID, "action": ["type": "moveCard", "taskId": taskID,
            "status": status, "taskRevision": try XCTUnwrap(row["taskRevision"]), "filters": try XCTUnwrap(view["filters"])]])])
    }

    func testPreparedBoardMoveNonterminalColumnsAndSameStatusNoop() async throws {
        let id = try await seedBoardActionFixture(), faults = HostIOFaults(), core = host()
        _ = try await core.start()
        let initial = try storedTask(id), protected = try storedTask(id + "-protected"), settings = try calendarPreferenceSettings()
        let initialAttachments = try XCTUnwrap(NativeJSON.jsonObject(with:
            Data(try XCTUnwrap(initial["attachments"] as? String).utf8)) as? [[String: Any]])
        await core.close()
        let writer = host(faults)
        _ = try await writer.start()
        var writes = 0, diagnostics = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        faults.commandDiagnostic = { if $0 == "boardMove" { diagnostics += 1 } }
        for status in ["waiting", "someday", "inbox", "next"] {
            let request = try await boardMovePayload(writer, taskID: id, status: status)
            let result = try object(await writer.call("boardAction", argumentsJSON: request))
            XCTAssertEqual(try json(result), try json(["changed": true, "open": NSNull()]))
            XCTAssertEqual(try storedTask(id)["status"] as? String, status)
            XCTAssertEqual(try json(storedTask(id + "-protected")), try json(protected))
            XCTAssertEqual(try json(calendarPreferenceSettings()), try json(settings))
            let attachments = try XCTUnwrap(NativeJSON.jsonObject(with:
                Data(try XCTUnwrap(storedTask(id)["attachments"] as? String).utf8)) as? [[String: Any]])
            XCTAssertEqual(try json(attachments), try json(initialAttachments))
            XCTAssertEqual(try storedTask(id)["checklist"] as? String, initial["checklist"] as? String)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        XCTAssertEqual(writes, 4); XCTAssertEqual(diagnostics, 1)
        let noop = try await boardMovePayload(writer, taskID: id, status: "next")
        let unchanged = try object(await writer.call("boardAction", argumentsJSON: noop))
        XCTAssertEqual(try json(unchanged), try json(["changed": false, "open": NSNull()]))
        XCTAssertEqual(writes, 4); XCTAssertEqual(diagnostics, 1)
        let final = try storedTask(id)
        await writer.close()
        let reopened = host()
        _ = try await reopened.start()
        XCTAssertEqual(try json(storedTask(id)), try json(final))
    }

    func testPreparedBoardMoveFailedCommitExactRetryAndLaterEditRefusal() async throws {
        let id = try await seedBoardActionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardMovePayload(core, taskID: id, status: "waiting")
        let before = try storedTask(id)
        var diagnostics = 0
        faults.commandDiagnostic = { if $0 == "boardMove" { diagnostics += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board Move COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: request) }
        let frozen = try object(String(contentsOf: journal))
        let frozenArgs = try XCTUnwrap(frozen["argumentsJSON"] as? String)
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(frozenArgs.utf8)) as? [String])
        let envelope = try object(XCTUnwrap(args.first)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        XCTAssertNotNil(prepared["move"]); XCTAssertEqual(prepared["deviceIdToInitialize"] is NSNull, true)
        XCTAssertEqual(try json(storedTask(id)), try json(before)); XCTAssertEqual(diagnostics, 0)
        await expectFailure("exact retry") { _ = try await core.call("boardAction", argumentsJSON: request) }
        await expectFailure("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(try object(String(contentsOf: journal))["argumentsJSON"] as? String, frozenArgs)
        faults.beforeSQL = nil
        let reply = try await core.retryPending()
        XCTAssertEqual(try json(object(XCTUnwrap(reply))), try json(XCTUnwrap(prepared["result"])))
        XCTAssertEqual(try storedTask(id)["status"] as? String, "waiting"); XCTAssertEqual(diagnostics, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        // A displayed pre-move revision is not authority for a later request.
        let submitted = try XCTUnwrap(NativeJSON.jsonObject(with: Data(request.utf8)) as? [String])
        var stale = try object(XCTUnwrap(submitted.first))
        stale["requestId"] = UUID().uuidString.lowercased()
        let staleRequest = try json([json(stale)])
        await expectFailure("STALE_REVISION") { _ = try await core.call("boardAction", argumentsJSON: staleRequest) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPreparedBoardMoveColdRecoveryRetainsExactOpaqueJournalAndAcknowledgment() async throws {
        for afterCommit in [false, true] {
            let id = try await seedBoardActionFixture(), faults = HostIOFaults(), core = host(faults)
            _ = try await core.start()
            let request = try await boardMovePayload(core, taskID: id, status: "waiting")
            if afterCommit {
                var saves = 0
                faults.journalWrite = { saves += 1; if saves == 2 { throw HostFailure("Injected Board Move lost reply") } }
            } else { faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board Move failed save") } } }
            await expectFailure { _ = try await core.call("boardAction", argumentsJSON: request) }
            let frozen = try object(String(contentsOf: journal)), encoded = try XCTUnwrap(frozen["argumentsJSON"] as? String)
            let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [String])
            let envelope = try object(XCTUnwrap(args.first)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            let expected = try json(XCTUnwrap(prepared["result"]))
            await core.close()
            let recoveryFaults = HostIOFaults(), replay = host(recoveryFaults)
            var writes = 0, diagnostics = 0
            recoveryFaults.beforeSQL = { sql in
                if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
            }
            recoveryFaults.commandDiagnostic = { if $0 == "boardMove" { diagnostics += 1 } }
            recoveryFaults.journalRemove = { throw HostFailure("Injected Board Move retirement failure") }
            await expectFailure("Injected Board Move retirement failure") { _ = try await replay.start() }
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(diagnostics, 0)
            XCTAssertEqual(try object(String(contentsOf: journal))["argumentsJSON"] as? String, encoded)
            let landed = try storedTask(id)
            recoveryFaults.journalRemove = nil
            let startup = try object(await replay.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
            XCTAssertEqual(recovery["method"] as? String, "boardCommit")
            XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), expected)
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(diagnostics, 1)
            XCTAssertEqual(try json(storedTask(id)), try json(landed))
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await replay.close()
        }
    }

    func testPreparedBoardMoveMalformedOpaqueTerminalJournalRefusesBeforeSQL() async throws {
        let id = try await seedBoardActionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardMovePayload(core, taskID: id, status: "waiting")
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board Move failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: request) }
        let frozen = try object(String(contentsOf: journal)), encoded = try XCTUnwrap(frozen["argumentsJSON"] as? String)
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [String])
        let envelope = try object(XCTUnwrap(args.first)), requestObject = try XCTUnwrap(envelope["request"] as? [String: Any])
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), expected = try json(XCTUnwrap(prepared["result"]))
        await core.close()
        let before = try Data(contentsOf: database)
        var missing = prepared; missing.removeValue(forKey: "move")
        var forged = prepared, move = try XCTUnwrap(prepared["move"] as? [String: Any])
        move["clock"] = [String: Any](); forged["move"] = move
        var minted = prepared; minted["deviceIdToInitialize"] = UUID().uuidString.lowercased()
        for candidate in [missing, forged, minted] {
            let arguments = try json([json(["request": requestObject, "prepared": candidate])])
            let bytes = try JSONSerialization.data(withJSONObject: ["version": 2, "method": "boardCommit",
                "argumentsJSON": arguments, "terminal": ["success": ["_0": expected]]], options: [.sortedKeys])
            try bytes.write(to: journal)
            let recoveryFaults = HostIOFaults(), replay = host(recoveryFaults)
            var sql = 0, diagnostics = 0
            recoveryFaults.beforeSQL = { _ in sql += 1 }
            recoveryFaults.commandDiagnostic = { if $0 == "boardMove" { diagnostics += 1 } }
            await expectFailure { _ = try await replay.start() }
            XCTAssertEqual(sql, 0); XCTAssertEqual(diagnostics, 0)
            XCTAssertEqual(try Data(contentsOf: journal), bytes); XCTAssertEqual(try Data(contentsOf: database), before)
            await replay.close()
        }
    }

}
