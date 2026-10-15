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


    // Completion fixtures reuse the wired runner/private bundle/service boundaries above.
    private func seedBoardCompletionFixture() async throws -> String {
        let id = try await seedBoardActionFixture(), sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        _ = try sqlite.execute("UPDATE tasks SET projectId = NULL, sectionId = NULL WHERE id = ?", parametersJSON: json([id]))
        return id
    }

    private func boardCompletionRequest(_ core: CoreHost, taskID: String, source: String? = "board") async throws -> [String: Any] {
        let editor = try object(await core.call("editorModel", argumentsJSON: json([taskID])))
        var request: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(),
                                    "taskRevision": try XCTUnwrap(editor["taskRevision"])]
        if let source { request["source"] = source }
        if source == "board" {
            let view = try object(await core.call("menuRead", argumentsJSON: json(["board", json(["limit": 100])])))
            let columns = try XCTUnwrap(view["columns"] as? [[String: Any]])
            let cards = columns.flatMap { $0["cards"] as? [[String: Any]] ?? [] }
            let card = try XCTUnwrap(cards.first { ($0["row"] as? [String: Any])?["id"] as? String == taskID })
            XCTAssertEqual(card["completeAllowed"] as? Bool, true)
            let row = try XCTUnwrap(card["row"] as? [String: Any])
            XCTAssertEqual(row["taskRevision"] as? String, request["taskRevision"] as? String)
        }
        return request
    }

    private func completionJournalEnvelope() throws -> (command: [String: Any], encoded: String, envelope: [String: Any]) {
        let command = try object(String(contentsOf: journal)), encoded = try XCTUnwrap(command["argumentsJSON"] as? String)
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [String])
        XCTAssertEqual(args.count, 1)
        return (command, encoded, try object(XCTUnwrap(args.first)))
    }

    func testPreparedBoardCompletionFourStatusesAndPublicUndo() async throws {
        let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let protected = try storedTask(id + "-protected"), settings = try calendarPreferenceSettings()
        var completed = 0, undone = 0, legacy = 0
        faults.commandDiagnostic = {
            if $0 == "boardCompletion:completed" { completed += 1 }
            if $0 == "boardCompletion:undone" { undone += 1 }
            if $0.hasPrefix("taskCompletion:") { legacy += 1 }
        }
        for status in ["waiting", "someday", "inbox", "next"] {
            _ = try await core.call("boardAction", argumentsJSON: boardMovePayload(core, taskID: id, status: status))
            let before = try storedTask(id), request = try await boardCompletionRequest(core, taskID: id)
            let reply = try object(await core.call("taskCompletion", argumentsJSON: json([json(request)])))
            XCTAssertEqual(Set(reply.keys), Set(["id", "completion"]))
            XCTAssertEqual(reply["id"] as? String, id)
            let notice = try XCTUnwrap(reply["completion"] as? [String: Any])
            XCTAssertEqual(try storedTask(id)["status"] as? String, "done")
            XCTAssertEqual(try storedTask(id)["completedAt"] as? String, notice["completedAt"] as? String)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
            let restored = try object(await core.call("taskCompletionUndo", argumentsJSON: json([json(undo)])))
            XCTAssertEqual(try json(restored), try json(["id": id]))
            XCTAssertEqual(try storedTask(id)["status"] as? String, status)
            let attachments = try NativeJSON.jsonObject(with: Data(XCTUnwrap(storedTask(id)["attachments"] as? String).utf8))
            let beforeAttachments = try NativeJSON.jsonObject(with: Data(XCTUnwrap(before["attachments"] as? String).utf8))
            XCTAssertEqual(try json(attachments), try json(beforeAttachments))
            XCTAssertEqual(try storedTask(id)["checklist"] as? String, before["checklist"] as? String)
            XCTAssertEqual(try json(storedTask(id + "-protected")), try json(protected))
            XCTAssertEqual(try json(calendarPreferenceSettings()), try json(settings))
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        XCTAssertEqual(completed, 4); XCTAssertEqual(undone, 4); XCTAssertEqual(legacy, 0)
    }

    func testPreparedBoardCompletionFailedCommitExactRetryAndUndo() async throws {
        let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardCompletionRequest(core, taskID: id), before = try storedTask(id)
        var completed = 0, undone = 0
        faults.commandDiagnostic = { if $0 == "boardCompletion:completed" { completed += 1 }; if $0 == "boardCompletion:undone" { undone += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
        let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
        XCTAssertEqual(prepared["version"] as? Int, 2); XCTAssertEqual(prepared["kind"] as? String, "boardComplete")
        XCTAssertNotNil(prepared["rawBefore"]); XCTAssertEqual(try json(storedTask(id)), try json(before)); XCTAssertEqual(completed, 0)
        await expectFailure("exact retry") { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
        await expectFailure("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
        faults.beforeSQL = nil
        let exactReply = try await core.retryPending()
        let reply = try object(XCTUnwrap(exactReply))
        XCTAssertEqual(try json(reply), try json(XCTUnwrap(prepared["result"]))); XCTAssertEqual(completed, 1)
        let outcome = try object(await core.call("taskCompletionRetryOutcome", argumentsJSON: json([json(request)])))
        XCTAssertEqual(try json(outcome), try json(["kind": "confirmed", "result": reply])); XCTAssertEqual(completed, 1)
        let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
        let landed = try storedTask(id)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion Undo COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("taskCompletionUndo", argumentsJSON: json([json(undo)])) }
        let frozenUndo = try completionJournalEnvelope(), undoPrepared = try XCTUnwrap(frozenUndo.envelope["prepared"] as? [String: Any])
        XCTAssertEqual(undoPrepared["version"] as? Int, 2); XCTAssertEqual(undoPrepared["kind"] as? String, "boardCompleteUndo")
        XCTAssertEqual(try json(storedTask(id)), try json(landed)); XCTAssertEqual(undone, 0)
        faults.beforeSQL = nil
        let exactUndoReply = try await core.retryPending()
        let restored = try object(XCTUnwrap(exactUndoReply))
        XCTAssertEqual(try json(restored), try json(["id": id])); XCTAssertEqual(undone, 1)
        XCTAssertEqual(try storedTask(id)["status"] as? String, "next")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPreparedBoardCompletionColdOriginUUIDRetirementAndUndo() async throws {
        for afterCommit in [false, true] {
            let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
            _ = try await core.start()
            let request = try await boardCompletionRequest(core, taskID: id)
            if afterCommit {
                var saves = 0
                faults.journalWrite = { saves += 1; if saves == 2 { throw HostFailure("Injected Board completion lost reply") } }
            } else { faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion failed save") } } }
            await expectFailure { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
            let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
            await core.close()
            let recoveryFaults = HostIOFaults(), replay = host(recoveryFaults)
            var writes = 0, diagnostics = 0
            recoveryFaults.beforeSQL = { sql in
                if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
            }
            recoveryFaults.commandDiagnostic = { if $0 == "boardCompletion:completed" { diagnostics += 1 } }
            recoveryFaults.journalRemove = { throw HostFailure("Injected Board completion retirement failure") }
            await expectFailure("Injected Board completion retirement failure") { _ = try await replay.start() }
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(diagnostics, 0)
            XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
            let landed = try storedTask(id)
            recoveryFaults.journalRemove = nil
            let startup = try object(await replay.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
            XCTAssertEqual(Set(recovery.keys), Set(["method", "source", "requestId", "result"]))
            XCTAssertEqual(recovery["method"] as? String, "taskCompletionCommit"); XCTAssertEqual(recovery["source"] as? String, "board")
            XCTAssertEqual(recovery["requestId"] as? String, request["requestId"] as? String)
            XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), try json(XCTUnwrap(prepared["result"])))
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(diagnostics, 1)
            XCTAssertEqual(try json(storedTask(id)), try json(landed)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
            var saves = 0
            recoveryFaults.journalWrite = { saves += 1; if saves == 2 { throw HostFailure("Injected Board Undo lost reply") } }
            await expectFailure { _ = try await replay.call("taskCompletionUndo", argumentsJSON: json([json(undo)])) }
            let undoFrozen = try completionJournalEnvelope(), undone = try storedTask(id)
            await replay.close()
            let undoFaults = HostIOFaults(), coldUndo = host(undoFaults)
            var undoWrites = 0, undoMarkers = 0
            undoFaults.beforeSQL = { sql in
                if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { undoWrites += 1 }
            }
            undoFaults.commandDiagnostic = { if $0 == "boardCompletion:undone" { undoMarkers += 1 } }
            let undoStartup = try object(await coldUndo.start()), undoRecovery = try XCTUnwrap(undoStartup["recovery"] as? [String: Any])
            XCTAssertEqual(Set(undoRecovery.keys), Set(["method", "source", "requestId", "result"]))
            XCTAssertEqual(undoRecovery["method"] as? String, "taskCompletionUndoCommit"); XCTAssertEqual(undoRecovery["source"] as? String, "board")
            XCTAssertEqual(undoRecovery["requestId"] as? String, undo["requestId"] as? String)
            XCTAssertEqual(try json(XCTUnwrap(undoRecovery["result"])), try json(XCTUnwrap((undoFrozen.envelope["prepared"] as? [String: Any])?["result"])))
            XCTAssertEqual(undoWrites, 0); XCTAssertEqual(undoMarkers, 1); XCTAssertEqual(try json(storedTask(id)), try json(undone))
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await coldUndo.close()
        }
    }

    func testPreparedBoardCompletionForgedOriginAndNestedUndoRefuseBeforeSQL() async throws {
        let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start(); let request = try await boardCompletionRequest(core, taskID: id)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
        let complete = try completionJournalEnvelope()
        faults.beforeSQL = nil; _ = try await core.retryPending()
        let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion Undo failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("taskCompletionUndo", argumentsJSON: json([json(undo)])) }
        let undoJournal = try completionJournalEnvelope(); await core.close()
        let before = try Data(contentsOf: database)
        for original in [complete, undoJournal] {
            let prepared = try XCTUnwrap(original.envelope["prepared"] as? [String: Any])
            var missingRaw = prepared; missingRaw.removeValue(forKey: "rawBefore")
            var wrongVersion = prepared; wrongVersion["version"] = 1
            var wrongKind = prepared; wrongKind["kind"] = "referenceComplete"
            var candidates = [missingRaw, wrongVersion, wrongKind].map { candidate in
                var envelope = original.envelope; envelope["prepared"] = candidate; return envelope
            }
            if original.command["method"] as? String == "taskCompletionCommit" {
                var forged = original.envelope, submitted = try XCTUnwrap(forged["request"] as? [String: Any]), inner = prepared
                submitted["source"] = "reference"; forged["request"] = submitted; inner["request"] = submitted
                forged["prepared"] = inner; candidates.append(forged)
            } else {
                var borrowed = original.envelope, submitted = try XCTUnwrap(borrowed["request"] as? [String: Any]), inner = prepared
                submitted["completionRequestId"] = UUID().uuidString.lowercased()
                borrowed["request"] = submitted; inner["request"] = submitted; borrowed["prepared"] = inner; candidates.append(borrowed)
                var forged = original.envelope, nested = try XCTUnwrap(prepared["completion"] as? [String: Any])
                var nestedPrepared = try XCTUnwrap(nested["prepared"] as? [String: Any])
                var nestedRequest = try XCTUnwrap(nestedPrepared["request"] as? [String: Any])
                nestedRequest["source"] = "reference"; nestedPrepared["request"] = nestedRequest; nested["prepared"] = nestedPrepared
                inner = prepared; inner["completion"] = nested; forged["prepared"] = inner; candidates.append(forged)
            }
            for envelope in candidates {
                let encoded = try json([json(envelope)]), result = try json(XCTUnwrap(prepared["result"]))
                let bytes = try JSONSerialization.data(withJSONObject: ["version": 2, "method": try XCTUnwrap(original.command["method"]),
                    "argumentsJSON": encoded, "terminal": ["success": ["_0": result]]], options: [.sortedKeys])
                try bytes.write(to: journal)
                let replayFaults = HostIOFaults(), replay = host(replayFaults); var sql = 0, diagnostics = 0
                replayFaults.beforeSQL = { _ in sql += 1 }; replayFaults.commandDiagnostic = { if $0.hasPrefix("boardCompletion:") { diagnostics += 1 } }
                await expectFailure { _ = try await replay.start() }
                XCTAssertEqual(sql, 0); XCTAssertEqual(diagnostics, 0)
                XCTAssertEqual(try Data(contentsOf: journal), bytes); XCTAssertEqual(try Data(contentsOf: database), before)
                await replay.close()
            }
        }
    }

    func testPreparedBoardCompletionTerminalWithoutReceiptRetainsJournal() async throws {
        try await assertBoardTerminalWithoutReceipt(undo: false)
    }

    func testPreparedBoardCompletionUndoTerminalWithoutReceiptRetainsJournal() async throws {
        try await assertBoardTerminalWithoutReceipt(undo: true)
    }

    private func assertBoardTerminalWithoutReceipt(undo: Bool) async throws {
        let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardCompletionRequest(core, taskID: id)
        if undo { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Board completion COMMIT failure") } }
        let submitted: [String: Any] = undo
            ? ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
            : request
        await expectFailure("SAVE_FAILED") {
            _ = try await core.call(undo ? "taskCompletionUndo" : "taskCompletion", argumentsJSON: json([json(submitted)]))
        }
        let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
        await core.close()
        var command = frozen.command
        command["terminal"] = ["success": ["_0": try json(XCTUnwrap(prepared["result"]))]]
        let bytes = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])
        try bytes.write(to: journal)
        // Cold boot repeats this idempotent schema insert before receipt probing.
        // Prove its row already exists so the only admitted DML attempt is a no-op.
        do {
            let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(
                "SELECT version FROM schema_migrations WHERE version = 1").utf8)) as? [[String: Any]])
            XCTAssertEqual(rows.count, 1); XCTAssertEqual(rows.first?["version"] as? Int, 1)
        }
        let before = try Data(contentsOf: database), replayFaults = HostIOFaults(), replay = host(replayFaults)
        var markers = 0
        var dmlStatements: [String] = []
        replayFaults.commandDiagnostic = { if $0.hasPrefix("boardCompletion:") { markers += 1 } }
        replayFaults.beforeSQL = { sql in
            let statement = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if ["INSERT", "UPDATE", "DELETE", "REPLACE"].contains(where: { statement.hasPrefix($0) }) { dmlStatements.append(statement) }
        }
        await expectFailure("no exact saved receipt") { _ = try await replay.start() }
        XCTAssertEqual(markers, 0)
        XCTAssertEqual(dmlStatements, ["INSERT OR IGNORE INTO SCHEMA_MIGRATIONS (VERSION) VALUES (1)"])
        XCTAssertEqual(try Data(contentsOf: journal), bytes)
        await replay.close()
        XCTAssertEqual(try Data(contentsOf: database), before)
    }

    func testPreparedBoardCompletionLegacyOrdinaryAndReferenceSourceCompatibility() async throws {
        let id = try await seedBoardCompletionFixture()
        let sources: [String?] = [nil, "reference"]
        for source in sources {
            let sqlite = try SQLiteBridge(url: database)
            _ = try sqlite.execute("UPDATE tasks SET status = ? WHERE id = ?", parametersJSON: json([source == nil ? "next" : "reference", id])); sqlite.close()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let request = try await boardCompletionRequest(core, taskID: id, source: source)
            var boardMarkers = 0
            faults.commandDiagnostic = { if $0.hasPrefix("boardCompletion:") { boardMarkers += 1 } }
            faults.journalRemove = { throw HostFailure("Injected legacy completion retirement") }
            await expectFailure("Injected legacy completion retirement") { _ = try await core.call("taskCompletion", argumentsJSON: json([json(request)])) }
            let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
            XCTAssertEqual(prepared["version"] as? Int, source == nil ? 1 : 2)
            XCTAssertEqual(prepared["kind"] as? String, source == nil ? "complete" : "referenceComplete")
            await core.close()
            let cold = host(), window = try object(await cold.start()), recovery = try XCTUnwrap(window["recovery"] as? [String: Any])
            XCTAssertEqual(recovery["source"] as? String, source); XCTAssertNil(recovery["requestId"])
            let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(request["requestId"])]
            _ = try await cold.call("taskCompletionUndo", argumentsJSON: json([json(undo)]))
            XCTAssertEqual(try storedTask(id)["status"] as? String, source == nil ? "next" : "reference")
            XCTAssertEqual(boardMarkers, 0); await cold.close()
        }
    }



    private func seedBoardReactivationFixture() async throws -> String {
        let id = try await seedBoardActionFixture(), sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        _ = try sqlite.execute("UPDATE tasks SET status = 'done', completedAt = ? WHERE id = ?",
            parametersJSON: json([formatter.string(from: Date()), id]))
        return id
    }

    func testPreparedBoardReactivationFourDestinationsAndColdRead() async throws {
        for status in ["inbox", "next", "waiting", "someday"] {
            let id = try await seedBoardReactivationFixture(), faults = HostIOFaults(), core = host(faults)
            _ = try await core.start()
            let before = try storedTask(id), protected = try storedTask(id + "-protected")
            let settings = try calendarPreferenceSettings()
            var markers = 0
            faults.commandDiagnostic = { if $0 == "boardReactivate" { markers += 1 } }
            let request = try await boardMovePayload(core, taskID: id, status: status)
            let result = try object(await core.call("boardAction", argumentsJSON: request))
            XCTAssertEqual(try json(result), try json(["changed": true, "open": NSNull()]))
            let after = try storedTask(id)
            XCTAssertEqual(after["status"] as? String, status)
            XCTAssertTrue(after["completedAt"] is NSNull)
            XCTAssertEqual(after["rev"] as? Int, try XCTUnwrap(before["rev"] as? Int) + 1)
            for name in ["id", "title", "description", "projectId", "sectionId", "checklist", "tags", "contexts"] {
                XCTAssertEqual(try json([XCTUnwrap(after[name])]), try json([XCTUnwrap(before[name])]), name)
            }
            let attachments = try XCTUnwrap(NativeJSON.jsonObject(with:
                Data(try XCTUnwrap(after["attachments"] as? String).utf8)) as? [[String: Any]])
            let beforeAttachments = try XCTUnwrap(NativeJSON.jsonObject(with:
                Data(try XCTUnwrap(before["attachments"] as? String).utf8)) as? [[String: Any]])
            XCTAssertEqual(try json(attachments), try json(beforeAttachments))
            XCTAssertEqual(try json(storedTask(id + "-protected")), try json(protected))
            XCTAssertEqual(try json(calendarPreferenceSettings()), try json(settings))
            XCTAssertEqual(markers, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await core.close()
            let cold = host(); _ = try await cold.start()
            XCTAssertEqual(try json(storedTask(id)), try json(after))
            await cold.close()
        }
    }

    func testPreparedBoardReactivationFailedCommitExactRetryAndStaleCompletionUndo() async throws {
        let id = try await seedBoardCompletionFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let completion = try await boardCompletionRequest(core, taskID: id)
        _ = try await core.call("taskCompletion", argumentsJSON: json([json(completion)]))
        let request = try await boardMovePayload(core, taskID: id, status: "next"), before = try storedTask(id)
        var markers = 0
        faults.commandDiagnostic = { if $0 == "boardReactivate" { markers += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected reactivation COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: request) }
        let frozen = try completionJournalEnvelope()
        XCTAssertEqual(try json(storedTask(id)), try json(before)); XCTAssertEqual(markers, 0)
        await expectFailure("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
        faults.beforeSQL = nil
        _ = try await core.retryPending()
        let after = try storedTask(id)
        XCTAssertEqual(after["status"] as? String, "next"); XCTAssertEqual(markers, 1)
        let undo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "completionRequestId": try XCTUnwrap(completion["requestId"])]
        await expectFailure { _ = try await core.call("taskCompletionUndo", argumentsJSON: json([json(undo)])) }
        XCTAssertEqual(try json(storedTask(id)), try json(after))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPreparedBoardReactivationColdRecoveryAndRetirementProof() async throws {
        for afterCommit in [false, true] {
            let id = try await seedBoardReactivationFixture(), faults = HostIOFaults(), core = host(faults)
            _ = try await core.start()
            let request = try await boardMovePayload(core, taskID: id, status: "waiting")
            if afterCommit {
                var saves = 0
                faults.journalWrite = { saves += 1; if saves == 2 { throw HostFailure("Injected reactivation lost reply") } }
            } else { faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected reactivation failed save") } } }
            await expectFailure { _ = try await core.call("boardAction", argumentsJSON: request) }
            let frozen = try completionJournalEnvelope()
            await core.close()
            let replayFaults = HostIOFaults(), replay = host(replayFaults)
            var writes = 0, markers = 0
            replayFaults.beforeSQL = { sql in
                if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
            }
            replayFaults.commandDiagnostic = { if $0 == "boardReactivate" { markers += 1 } }
            replayFaults.journalRemove = { throw HostFailure("Injected reactivation retirement failure") }
            await expectFailure("Injected reactivation retirement failure") { _ = try await replay.start() }
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(markers, 0)
            XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
            let landed = try storedTask(id)
            replayFaults.journalRemove = nil
            let window = try object(await replay.start()), recovery = try XCTUnwrap(window["recovery"] as? [String: Any])
            XCTAssertEqual(recovery["method"] as? String, "boardCommit")
            XCTAssertEqual(try json(storedTask(id)), try json(landed))
            XCTAssertEqual(writes, afterCommit ? 0 : 1); XCTAssertEqual(markers, 1)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await replay.close()
        }
    }

    func testPreparedBoardReactivationWarmRetryPreservesArchivedParent() async throws {
        let id = try await seedBoardReactivationFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardMovePayload(core, taskID: id, status: "next"), before = try storedTask(id)
        var markers = 0
        faults.commandDiagnostic = { if $0 == "boardReactivate" { markers += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected reactivation failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: request) }
        let sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("UPDATE projects SET status = 'archived' WHERE id = 'destination-project-a'")
        let archived = try sqlite.execute("SELECT * FROM projects WHERE id = 'destination-project-a'")
        sqlite.close()
        faults.beforeSQL = nil
        await expectFailure { _ = try await core.retryPending() }
        XCTAssertEqual(try json(storedTask(id)), try json(before)); XCTAssertEqual(markers, 0)
        let check = try SQLiteBridge(url: database); defer { check.close() }
        let currentProject = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try check.execute(
            "SELECT * FROM projects WHERE id = 'destination-project-a'").utf8)) as? [[String: Any]])
        let archivedProject = try XCTUnwrap(NativeJSON.jsonObject(with: Data(archived.utf8)) as? [[String: Any]])
        XCTAssertEqual(try json(currentProject), try json(archivedProject))
    }

    func testPreparedBoardReactivationTerminalWithoutSavedEffectRetainsJournal() async throws {
        let id = try await seedBoardReactivationFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let request = try await boardMovePayload(core, taskID: id, status: "next")
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected reactivation failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: request) }
        let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
        await core.close()
        var command = frozen.command
        command["terminal"] = ["success": ["_0": try json(XCTUnwrap(prepared["result"]))]]
        let bytes = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])
        try bytes.write(to: journal)
        do {
            let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(
                "SELECT version FROM schema_migrations WHERE version = 1").utf8)) as? [[String: Any]])
            XCTAssertEqual(rows.count, 1); XCTAssertEqual(rows.first?["version"] as? Int, 1)
        }
        let before = try Data(contentsOf: database), replayFaults = HostIOFaults(), replay = host(replayFaults)
        var markers = 0, dml: [String] = []
        replayFaults.commandDiagnostic = { if $0 == "boardReactivate" { markers += 1 } }
        replayFaults.beforeSQL = { sql in
            let statement = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if ["INSERT", "UPDATE", "DELETE", "REPLACE"].contains(where: { statement.hasPrefix($0) }) { dml.append(statement) }
        }
        await expectFailure("no exact saved effect") { _ = try await replay.start() }
        XCTAssertEqual(markers, 0)
        XCTAssertEqual(dml, ["INSERT OR IGNORE INTO SCHEMA_MIGRATIONS (VERSION) VALUES (1)"])
        XCTAssertEqual(try Data(contentsOf: journal), bytes)
        await replay.close()
        XCTAssertEqual(try Data(contentsOf: database), before)
    }


    private func seedBoardOrderFixture(dense: Bool = false) async throws -> [String] {
        let first = try await seedBoardActionFixture(), writer = host()
        let ids = [first, UUID().uuidString.lowercased(), UUID().uuidString.lowercased()]
        _ = try await writer.start()
        for id in ids.dropFirst() {
            _ = try await writer.call("captureSubmit", argumentsJSON: capture(writer, title: "Order peer", id: id))
        }
        await writer.close()
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        for (index, id) in ids.enumerated() {
            _ = try sqlite.execute("UPDATE tasks SET status = 'next', boardOrder = ? WHERE id = ?",
                parametersJSON: json([dense ? index : index * 1024, id]))
        }
        return ids
    }

    private func boardOrderPayload(_ core: CoreHost, taskID: String, afterID: String?) async throws -> String {
        let view = try object(await core.call("menuRead", argumentsJSON: json(["board", json(["limit": 100])])))
        let columns = try XCTUnwrap(view["columns"] as? [[String: Any]])
        let column = try XCTUnwrap(columns.first { $0["status"] as? String == "next" })
        let cards = try XCTUnwrap(column["cards"] as? [[String: Any]])
        let row = try XCTUnwrap(cards.first { ($0["row"] as? [String: Any])?["id"] as? String == taskID }?["row"] as? [String: Any])
        let order = try XCTUnwrap(column["order"] as? [String: Any]); XCTAssertEqual(order["available"] as? Bool, true)
        return try json([json(["requestId": UUID().uuidString, "action": ["type": "orderCard", "taskId": taskID,
            "taskRevision": try XCTUnwrap(row["taskRevision"]), "status": "next", "afterId": afterID as Any? ?? NSNull(),
            "filters": try XCTUnwrap(view["filters"]), "expectedOrder": try XCTUnwrap(order["expectedOrder"])]])])
    }

    private func boardOrderRows(_ ids: [String]) throws -> String { try json(ids.map { try storedTask($0) }) }

    private func boardOrderReceiptCount() throws -> Int {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(
            "SELECT COUNT(*) AS count FROM native_request_receipts WHERE method LIKE 'boardTaskOrder:%'").utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first?["count"] as? Int)
    }

    private func assertBoardOrderEffects(_ envelope: [String: Any], ids: [String], before: [[String: Any]]) throws {
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), effect = try XCTUnwrap(prepared["effect"] as? [String: Any])
        let pairs = try XCTUnwrap(effect["tasks"] as? [[String: Any]])
        let changed = Set(try pairs.map { try XCTUnwrap(($0["after"] as? [String: Any])?["id"] as? String) })
        for (index, id) in ids.enumerated() {
            let after = try storedTask(id)
            if let pair = pairs.first(where: { ($0["after"] as? [String: Any])?["id"] as? String == id }), let planned = pair["after"] as? [String: Any] {
                for name in ["boardOrder", "rev", "revBy", "updatedAt"] {
                    XCTAssertEqual(try json([XCTUnwrap(after[name])]), try json([XCTUnwrap(planned[name])]), name)
                }
            } else { XCTAssertEqual(try json(after), try json(before[index])) }
            for name in ["id", "title", "status", "projectId", "sectionId", "areaId", "description", "orderNum", "dueDate", "startTime"] {
                XCTAssertEqual(try json([XCTUnwrap(after[name])]), try json([XCTUnwrap(before[index][name])]), name)
            }
            for name in ["attachments", "checklist", "tags", "contexts"] {
                let current = try XCTUnwrap(after[name]), original = try XCTUnwrap(before[index][name])
                if let a = current as? String, let b = original as? String {
                    XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(a.utf8))), try json(NativeJSON.jsonObject(with: Data(b.utf8))), name)
                } else { XCTAssertEqual(try json([current]), try json([original]), name) }
            }
            XCTAssertEqual(after["rev"] as? Int, try XCTUnwrap(before[index]["rev"] as? Int) + (changed.contains(id) ? 1 : 0))
        }
    }

    func testPreparedBoardOrderSparseNoopAndColdRead() async throws {
        let ids = try await seedBoardOrderFixture(), faults = HostIOFaults(), core = host(faults)
        var seededSettings = try calendarPreferenceSettings(); seededSettings["deviceId"] = "device-a"
        let sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("UPDATE settings SET data = ? WHERE id = 1", parametersJSON: json([json(seededSettings)])); sqlite.close()
        _ = try await core.start()
        let before = try boardOrderRows(ids), protected = try storedTask(ids[0] + "-protected"), settings = try calendarPreferenceSettings()
        var markers = 0; faults.commandDiagnostic = { if $0 == "boardOrder" { markers += 1 } }
        let noop = try object(await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[1])))
        XCTAssertEqual(try json(noop), try json(["changed": false, "open": NSNull()]))
        XCTAssertEqual(try boardOrderRows(ids), before); XCTAssertEqual(try boardOrderReceiptCount(), 0)
        XCTAssertEqual(markers, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        faults.journalRemove = { throw HostFailure("Injected order retirement failure") }
        await expectFailure("Injected order retirement failure") {
            _ = try await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[0]))
        }
        let frozen = try completionJournalEnvelope()
        XCTAssertEqual((frozen.envelope["prepared"] as? [String: Any])?["deviceIdBefore"] as? String, "device-a")
        try assertBoardOrderEffects(frozen.envelope, ids: ids, before: XCTUnwrap(NativeJSON.jsonObject(with: Data(before.utf8)) as? [[String: Any]]))
        XCTAssertEqual(try boardOrderReceiptCount(), 1); XCTAssertEqual(markers, 0)
        faults.journalRemove = nil; _ = try await core.retryPending()
        XCTAssertEqual(markers, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let landed = try boardOrderRows(ids)
        XCTAssertEqual(try json(storedTask(ids[0] + "-protected")), try json(protected))
        XCTAssertEqual(try json(calendarPreferenceSettings()), try json(settings)); await core.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try boardOrderRows(ids), landed); XCTAssertEqual(try boardOrderReceiptCount(), 1); await cold.close()
    }

    func testPreparedBoardOrderRebalanceFailedCommitExactRetry() async throws {
        let ids = try await seedBoardOrderFixture(dense: true), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        let before = try boardOrderRows(ids), protected = try storedTask(ids[0] + "-protected"); var markers = 0
        faults.commandDiagnostic = { if $0 == "boardOrder" { markers += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected order COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[0])) }
        let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any])
        let effect = try XCTUnwrap(prepared["effect"] as? [String: Any])
        XCTAssertGreaterThan(try XCTUnwrap(effect["tasks"] as? [[String: Any]]).count, 1)
        XCTAssertEqual(try boardOrderRows(ids), before); XCTAssertEqual(try boardOrderReceiptCount(), 0); XCTAssertEqual(markers, 0)
        await expectFailure("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
        XCTAssertEqual(try boardOrderRows(ids), before); XCTAssertEqual(try boardOrderReceiptCount(), 0)
        faults.beforeSQL = nil; _ = try await core.retryPending()
        try assertBoardOrderEffects(frozen.envelope, ids: ids, before: XCTUnwrap(NativeJSON.jsonObject(with: Data(before.utf8)) as? [[String: Any]]))
        XCTAssertEqual(try boardOrderReceiptCount(), 1); XCTAssertEqual(markers, 1)
        XCTAssertEqual(try json(storedTask(ids[0] + "-protected")), try json(protected)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPreparedBoardOrderColdLostReplyAndRetirementProof() async throws {
        let ids = try await seedBoardOrderFixture(dense: true), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start(); var saves = 0
        faults.journalWrite = { saves += 1; if saves == 2 { throw HostFailure("Injected order lost reply") } }
        await expectFailure { _ = try await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[0])) }
        let frozen = try completionJournalEnvelope(), landed = try boardOrderRows(ids)
        XCTAssertEqual(try boardOrderReceiptCount(), 1); await core.close()
        let replayFaults = HostIOFaults(), replay = host(replayFaults); var writes = 0, markers = 0
        replayFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        replayFaults.commandDiagnostic = { if $0 == "boardOrder" { markers += 1 } }
        replayFaults.journalRemove = { throw HostFailure("Injected order retirement failure") }
        await expectFailure("Injected order retirement failure") { _ = try await replay.start() }
        XCTAssertEqual(writes, 0); XCTAssertEqual(markers, 0); XCTAssertEqual(try completionJournalEnvelope().encoded, frozen.encoded)
        XCTAssertEqual(try boardOrderRows(ids), landed); replayFaults.journalRemove = nil
        let window = try object(await replay.start()), recovery = try XCTUnwrap(window["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "boardCommit")
        XCTAssertEqual(writes, 0); XCTAssertEqual(markers, 1); XCTAssertEqual(try boardOrderRows(ids), landed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await replay.close()
        // A saved receipt alone cannot retire an old terminal after any affected row was edited.
        let prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any]), effect = try XCTUnwrap(prepared["effect"] as? [String: Any])
        let changed = try XCTUnwrap(effect["tasks"] as? [[String: Any]])
        let editedID = try XCTUnwrap((changed.first?["after"] as? [String: Any])?["id"] as? String)
        let sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("UPDATE tasks SET description = 'Later order edit' WHERE id = ?", parametersJSON: json([editedID])); sqlite.close()
        var terminal = frozen.command; terminal["terminal"] = ["success": ["_0": try json(XCTUnwrap(prepared["result"]))]]
        let terminalBytes = try JSONSerialization.data(withJSONObject: terminal, options: [.sortedKeys]); try terminalBytes.write(to: journal)
        let edited = try boardOrderRows(ids), staleFaults = HostIOFaults(), stale = host(staleFaults)
        var staleMarkers = 0; staleFaults.commandDiagnostic = { if $0 == "boardOrder" { staleMarkers += 1 } }
        await expectFailure("no exact saved effect") { _ = try await stale.start() }
        XCTAssertEqual(staleMarkers, 0); XCTAssertEqual(try boardOrderReceiptCount(), 1)
        XCTAssertEqual(try boardOrderRows(ids), edited); XCTAssertEqual(try Data(contentsOf: journal), terminalBytes)
        await stale.close()
    }

    func testPreparedBoardOrderTerminalWithoutReceiptRetainsJournal() async throws {
        let ids = try await seedBoardOrderFixture(dense: true), faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected order failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[0])) }
        let frozen = try completionJournalEnvelope(), prepared = try XCTUnwrap(frozen.envelope["prepared"] as? [String: Any]); await core.close()
        var command = frozen.command; command["terminal"] = ["success": ["_0": try json(XCTUnwrap(prepared["result"]))]]
        let bytes = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys]); try bytes.write(to: journal)
        let sqlite = try SQLiteBridge(url: database)
        let migrations = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT version FROM schema_migrations WHERE version = 1").utf8)) as? [[String: Any]])
        XCTAssertEqual(migrations.count, 1); sqlite.close()
        let before = try Data(contentsOf: database), replayFaults = HostIOFaults(), replay = host(replayFaults); var markers = 0, dml: [String] = []
        replayFaults.commandDiagnostic = { if $0 == "boardOrder" { markers += 1 } }
        replayFaults.beforeSQL = { sql in
            let statement = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if ["INSERT", "UPDATE", "DELETE", "REPLACE"].contains(where: { statement.hasPrefix($0) }) { dml.append(statement) }
        }
        await expectFailure("no exact saved effect") { _ = try await replay.start() }
        XCTAssertEqual(markers, 0); XCTAssertEqual(try boardOrderReceiptCount(), 0)
        XCTAssertEqual(dml, ["INSERT OR IGNORE INTO SCHEMA_MIGRATIONS (VERSION) VALUES (1)"])
        XCTAssertEqual(try Data(contentsOf: journal), bytes); await replay.close(); XCTAssertEqual(try Data(contentsOf: database), before)
    }

    func testPreparedBoardOrderMalformedAndOversizedColdJournalBeforeSQL() async throws {
        let ids = try await seedBoardOrderFixture(dense: true), faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected order failed save") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("boardAction", argumentsJSON: boardOrderPayload(core, taskID: ids[2], afterID: ids[0])) }
        let frozen = try completionJournalEnvelope(); await core.close(); let before = try Data(contentsOf: database)
        for malformed in ["duplicate", "effect", "unknown", "oversize"] {
            var command = frozen.command, envelope = frozen.envelope, prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            var effect = try XCTUnwrap(prepared["effect"] as? [String: Any]), pairs = try XCTUnwrap(effect["tasks"] as? [[String: Any]])
            if malformed == "duplicate" { pairs.append(try XCTUnwrap(pairs.first)) }
            if malformed == "effect" {
                var pair = try XCTUnwrap(pairs.first), after = try XCTUnwrap(pair["after"] as? [String: Any])
                after["boardOrder"] = 999999; pair["after"] = after; pairs[0] = pair
            }
            if malformed == "unknown" { prepared["untrusted"] = true }
            effect["tasks"] = pairs; prepared["effect"] = effect; envelope["prepared"] = prepared; command["argumentsJSON"] = try json([json(envelope)])
            var bytes = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])
            if malformed == "oversize" { bytes.append(Data(repeating: 0x20, count: NativeBoardOrderJournalBudget.maximumBytes + 1)) }
            try bytes.write(to: journal)
            let replayFaults = HostIOFaults(), replay = host(replayFaults); var statements = 0, markers = 0
            replayFaults.beforeSQL = { _ in statements += 1 }; replayFaults.commandDiagnostic = { if $0 == "boardOrder" { markers += 1 } }
            await expectFailure { _ = try await replay.start() }
            XCTAssertEqual(statements, 0, malformed); XCTAssertEqual(markers, 0, malformed); XCTAssertEqual(try Data(contentsOf: journal), bytes, malformed)
            await replay.close(); XCTAssertEqual(try Data(contentsOf: database), before, malformed)
        }
    }

    func testPreparedBoardOrderExactInitialAndAcknowledgedJournalByteBoundary() throws {
        let exact = Data(repeating: 0x20, count: NativeBoardOrderJournalBudget.maximumBytes)
        let excess = Data(repeating: 0x20, count: NativeBoardOrderJournalBudget.maximumBytes + 1)
        XCTAssertNoThrow(try NativeBoardOrderJournalBudget.require(exact, acknowledged: exact))
        XCTAssertThrowsError(try NativeBoardOrderJournalBudget.require(excess, acknowledged: exact))
        // Preflight the real success-terminal encoding before journaling, avoiding an unretirable accepted save.
        XCTAssertThrowsError(try NativeBoardOrderJournalBudget.require(exact, acknowledged: excess))
    }

    func testInboxTokenReadValidatesWindowWithoutWriting() async throws {
        let faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let view = try object(await core.call("inboxView", argumentsJSON: json([json(["offset": 0, "limit": 100])])))
        let revision = try XCTUnwrap(view["revision"] as? String)
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        func snapshot(_ sql: String) throws -> String {
            // Preserve raw cell values while ignoring dictionary key order in the bridge's JSON envelope.
            try json(NativeJSON.jsonObject(with: Data(sqlite.execute(sql).utf8)))
        }
        let before = try snapshot("SELECT * FROM settings ORDER BY id")
        let receipts = try snapshot("SELECT * FROM native_request_receipts ORDER BY rowid")
        let input: [String: Any] = ["offset": 0, "limit": 100, "revision": revision]
        let result = try object(await core.call("menuRead", argumentsJSON: json(["inboxTokens", json(input)])))
        XCTAssertEqual(result["revision"] as? String, revision)
        XCTAssertEqual(result["total"] as? Int, 0)
        XCTAssertEqual((result["items"] as? [Any])?.count, 0)
        let filters: [String: Any] = ["tokens": (0..<100).map { "@token-\($0)" }]
        let bounded = try object(await core.call("inboxView", argumentsJSON: json([json([
            "filters": filters, "offset": 0, "limit": 100])])) )
        _ = try await core.call("menuRead", argumentsJSON: json(["inboxTokens", json([
            "params": ["filters": filters], "offset": 0, "limit": 100,
            "revision": XCTUnwrap(bounded["revision"] as? String)])]))
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("inboxView", argumentsJSON: self.json([self.json([
                "filters": filters, "filterEdit": ["type": "toggleToken", "value": "@overflow"],
                "offset": 0, "limit": 100])]))
        }
        let invalidChanges: [[String: Any]] = [
            ["offset": -1], ["offset": true], ["limit": 0], ["limit": 101],
            ["query": String(repeating: "x", count: 501)],
            ["params": ["filterEdit": ["type": "clear"]]],
            ["params": ["filters": ["tokens": Array(repeating: "@test", count: 101)]]],
        ]
        for change in invalidChanges {
            let invalid = input.merging(change) { _, next in next }
            await expectFailure("INVALID_INPUT") {
                _ = try await core.call("menuRead", argumentsJSON: self.json(["inboxTokens", self.json(invalid)]))
            }
        }
        let duplicate = "{\"offset\":0,\"offset\":1,\"limit\":100,\"revision\":\"ignored\"}"
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("menuRead", argumentsJSON: self.json(["inboxTokens", duplicate]))
        }
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(try snapshot("SELECT * FROM settings ORDER BY id"), before)
        XCTAssertEqual(try snapshot("SELECT * FROM native_request_receipts ORDER BY rowid"), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testBoardDragSubmittedDiagnosticIsContentFreeAndDoesNotClaimSavedEffect() async throws {
        let ids = try await seedBoardOrderFixture(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        _ = try await core.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString, "edit": ["type": "debugLogging", "value": true],
        ])]))
        let before = try boardOrderRows(ids), settings = try calendarPreferenceSettings()
        let receipts = try boardOrderReceiptCount()
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let message = "Native iOS Board drag submitted", context = ["releaseCheck": "v1.3.5/ios-board-drag"]
        let result = try await core.call("logLine", argumentsJSON: json([message, json(context)]))
        XCTAssertEqual(result, "{}")
        for extra in ["nonce", "taskId", "text", "providerBytes", "outcome"] {
            var forged = context; forged[extra] = extra == "outcome" ? "saved" : "private"
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([message, json(forged)])) }
        }
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("logLine", argumentsJSON: json([message, json(["releaseCheck": "v1.3.5/ios-board-order"])]))
        }
        let stageMessage = "Native iOS Board drag stage", stageTag = "v1.3.5/ios-board-drag-stage"
        let stageReasons = [
            "begin": ["scene", "admission", "geometry-missing", "geometry-ineligible", "ready"],
            "cancel": ["new-drag", "model", "scene", "disappear", "geometry-missing", "geometry-viewport", "geometry-area", "geometry-rows", "geometry-other"],
            "validate": ["scene", "capture", "column", "claimed", "stale", "geometry", "provider-count", "provider-types", "ready"],
            "hover": ["position-rejected", "ready"],
            "drop": ["provider-count", "provider-types", "scene", "capture", "column", "claimed", "stale", "geometry", "position-or-claim", "ready"],
            "load": ["error", "payload", "claim", "scene", "geometry", "position", "nonce", "retain-rejected", "ready"],
        ]
        var stageContexts: [[String: String]] = []
        for stage in stageReasons.keys.sorted() {
            for reason in stageReasons[stage] ?? [] {
                let value = ["releaseCheck": stageTag, "stage": stage, "reason": reason]
                _ = try await core.call("logLine", argumentsJSON: json([stageMessage, json(value)]))
                stageContexts.append(value)
            }
        }
        let stageContext = ["releaseCheck": stageTag, "stage": "begin", "reason": "ready"]
        for extra in ["nonce", "taskId", "text", "providerBytes", "geometry", "outcome"] {
            var forged = stageContext; forged[extra] = extra == "outcome" ? "saved" : "private"
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([stageMessage, json(forged)])) }
        }
        for forged in [
            ["releaseCheck": "v1.3.5/ios-board-drag", "stage": "begin", "reason": "ready"],
            ["releaseCheck": stageTag, "stage": "unknown", "reason": "ready"],
            ["releaseCheck": stageTag, "stage": "begin", "reason": "private"],
            ["releaseCheck": stageTag, "stage": "begin", "reason": "provider-types"],
            ["releaseCheck": stageTag, "stage": "begin"],
        ] {
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([stageMessage, json(forged)])) }
        }
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("logLine", argumentsJSON: json([stageMessage,
                #"{"releaseCheck":"v1.3.5/ios-board-drag-stage","stage":"begin","reason":0}"#]))
        }
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("logLine", argumentsJSON: json([stageMessage,
                #"{"releaseCheck":"v1.3.5/ios-board-drag-stage","stage":"begin","reason":"ready","reason":"private"}"#]))
        }
        let pagingMessage = "Native iOS Inbox paging recovered"
        let pagingContext: [String: Any] = ["releaseCheck": "v1.3.5/ios-inbox-paging", "outcome": "recovered", "count": 55]
        _ = try await core.call("logLine", argumentsJSON: json([pagingMessage, json(pagingContext)]))
        for count in [true, "55", -1, 0.5, NSNull()] as [Any] {
            var forged = pagingContext; forged["count"] = count
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([pagingMessage, json(forged)])) }
        }
        for field in ["taskId", "revision", "text", "path"] {
            var forged = pagingContext; forged[field] = "private"
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([pagingMessage, json(forged)])) }
        }
        for (field, value) in [("releaseCheck", "v1.3.5/ios-board-drag"), ("outcome", "saved")] {
            var forged = pagingContext; forged[field] = value
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([pagingMessage, json(forged)])) }
        }
        let filterMessage = "Native iOS Inbox filters applied"
        let filterContext: [String: Any] = ["releaseCheck": "v1.3.5/ios-inbox-filters", "operation": "edit", "count": 3]
        _ = try await core.call("logLine", argumentsJSON: json([filterMessage, json(filterContext)]))
        for (field, value) in [("count", true), ("count", "3"), ("count", -1), ("count", 1001),
            ("count", 0.5), ("count", NSNull()), ("operation", "saved"), ("releaseCheck", "v1.3.5/ios-inbox-group"),
            ("query", "private"), ("token", "private"), ("location", "private"), ("revision", "private")] as [(String, Any)] {
            var forged = filterContext; forged[field] = value
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([filterMessage, json(forged)])) }
        }
        for field in filterContext.keys {
            var forged = filterContext; forged.removeValue(forKey: field)
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([filterMessage, json(forged)])) }
        }
        let groupMessage = "Native iOS Inbox grouping applied"
        var groupContexts: [[String: Any]] = []
        for operation in ["group", "fold"] {
            for axis in ["none", "context", "area", "project", "tag"] {
                let context: [String: Any] = ["releaseCheck": "v1.3.5/ios-inbox-group",
                    "operation": operation, "axis": axis, "collapsedCount": operation == "fold" ? 200 : 0]
                _ = try await core.call("logLine", argumentsJSON: json([groupMessage, json(context)]))
                groupContexts.append(context)
            }
        }
        let groupContext = groupContexts[0]
        for (field, value) in [("collapsedCount", true), ("collapsedCount", "1"), ("collapsedCount", -1),
            ("collapsedCount", 201), ("collapsedCount", 0.5), ("collapsedCount", NSNull()),
            ("releaseCheck", "v1.3.5/ios-inbox-paging"), ("axis", "private"), ("operation", "saved")] as [(String, Any)] {
            var forged = groupContext; forged[field] = value
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([groupMessage, json(forged)])) }
        }
        for field in ["taskId", "text", "revision", "preferences", "path", "outcome"] {
            var forged = groupContext; forged[field] = "private"
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([groupMessage, json(forged)])) }
        }
        for field in groupContext.keys {
            var forged = groupContext; forged.removeValue(forKey: field)
            await expectFailure("INVALID_INPUT") { _ = try await core.call("logLine", argumentsJSON: json([groupMessage, json(forged)])) }
        }
        let shared = try object(await core.diagnosticsFileAction("logShare"))
        let url = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { try object(String($0)) }
        let submitted = lines.filter { $0["message"] as? String == message }
        XCTAssertEqual(submitted.count, 1)
        XCTAssertEqual(try json(XCTUnwrap(submitted.first?["context"])), try json(context))
        let stages = lines.filter { $0["message"] as? String == stageMessage }
        XCTAssertEqual(stages.count, stageContexts.count)
        XCTAssertEqual(try stages.map { try json(XCTUnwrap($0["context"])) }.sorted(), try stageContexts.map { try json($0) }.sorted())
        let paging = lines.filter { $0["message"] as? String == pagingMessage }
        XCTAssertEqual(paging.count, 1)
        XCTAssertEqual(try json(XCTUnwrap(paging.first?["context"])), try json([
            "releaseCheck": "v1.3.5/ios-inbox-paging", "outcome": "recovered", "count": "55"]))
        let filtering = lines.filter { $0["message"] as? String == filterMessage }
        XCTAssertEqual(filtering.count, 1)
        XCTAssertEqual(filtering.first?["scope"] as? String, "native-ios")
        XCTAssertEqual(try json(XCTUnwrap(filtering.first?["context"])), try json([
            "releaseCheck": "v1.3.5/ios-inbox-filters", "operation": "edit", "count": "3"]))
        let grouping = lines.filter { $0["message"] as? String == groupMessage }
        XCTAssertEqual(grouping.count, groupContexts.count)
        let exportedGroupContexts = groupContexts.map { context -> [String: Any] in
            var value = context; value["collapsedCount"] = String((context["collapsedCount"] as? Int) ?? -1); return value
        }
        XCTAssertEqual(try grouping.map { try json(XCTUnwrap($0["context"])) }.sorted(),
            try exportedGroupContexts.map { try json($0) }.sorted())
        XCTAssertFalse(lines.contains { $0["message"] as? String == "Native iOS Board order saved" })
        XCTAssertEqual(writes, 0); XCTAssertEqual(try boardOrderRows(ids), before)
        XCTAssertEqual(try json(calendarPreferenceSettings()), try json(settings))
        XCTAssertEqual(try boardOrderReceiptCount(), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

}
