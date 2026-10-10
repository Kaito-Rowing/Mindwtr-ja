import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAppleRemindersImportRunTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.reminders-run-test"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var snapshotCount: Int {
        (try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("backup-snapshots"), includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(".snapshot.json") }.count) ?? 0
    }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual host bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        try settings()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func settings(ids: [String] = [], automatic: Bool = true, delete: Bool = false) throws {
        let store = try NativeDeviceKV(containerURL: root, bundleIdentifier: namespace); defer { store.close() }
        let raw = try json(["selectedListId": "list", "selectedListTitle": "List", "importedReminderIds": ids,
            "autoImportOnOpen": automatic, "deleteImportedReminders": delete])
        try store.compareAndSetAppleRemindersImportState(expected: store.readAppleRemindersImportState(), next: raw)
    }
    private func host(_ sdk: AppleRemindersTestSDK, faults: HostIOFaults = HostIOFaults(), permission: NativeAppleRemindersPermission = .granted) -> CoreHost {
        faults.appleRemindersProviderFactory = { NativeAppleRemindersProvider(status: { permission }, sdkFactory: { sdk }) }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: root, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func rows() throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT * FROM tasks").utf8)) as? [[String: Any]])
    }
    private func row(_ id: String, title: String = "Literal @home /due:today", completed: Bool = false) -> NativeAppleReminderSDKRow {
        .init(list: .init(id: "list", sourceID: "account"), source: .init(id: id, title: title, notes: "Notes", completed: completed,
            creationDate: nil, startDate: nil, dueDate: nil))
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }

    func testSharedSkipCountsAndLiteralTasksWithOneSnapshot() async throws {
        try settings(ids: ["known"])
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("known"), row("done", completed: true), row("empty", title: "  "), row("first"), row("second")]
        let core = host(sdk); _ = try await core.start()
        let reply = try object(await core.importAppleReminders())
        XCTAssertEqual(reply["kind"] as? String, "completed")
        let counts = try XCTUnwrap(reply["result"] as? [String: Int])
        XCTAssertEqual(counts, ["importedCount": 2, "deletedCount": 0, "deleteFailedCount": 0, "skippedDuplicateCount": 1,
            "skippedCompletedCount": 1, "skippedEmptyTitleCount": 1, "failedCount": 0])
        XCTAssertEqual(snapshotCount, 1); XCTAssertEqual(sdk.requests, 0)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("Native Reminders import run finished")); XCTAssertTrue(log.contains("v1.3.5/ios-reminders-run"))
        await core.close()
        XCTAssertEqual(try rows().count, 2); XCTAssertTrue(try rows().allSatisfy { $0["title"] as? String == "Literal @home /due:today" && $0["dueDate"] is NSNull })
    }

    func testSkipOnlyAndEmptyRunsCreateNoSnapshot() async throws {
        try settings(ids: ["known"])
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("known"), row("done", completed: true), row("empty", title: "")]
        let core = host(sdk); _ = try await core.start()
        _ = try await core.importAppleReminders(); XCTAssertEqual(snapshotCount, 0)
        sdk.immediate = []; _ = try await core.importAppleReminders(); XCTAssertEqual(snapshotCount, 0)
        await core.close(); XCTAssertEqual(try rows().count, 0)
    }

    func testEachNewRunGetsFreshProviderRowsAndItsOwnSnapshot() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first")]
        let core = host(sdk); _ = try await core.start(); _ = try await core.importAppleReminders()
        sdk.immediate = [row("first"), row("second")]
        let next = try object(await core.importAppleReminders())
        XCTAssertEqual((next["result"] as? [String: Int])?["importedCount"], 1)
        XCTAssertEqual((next["result"] as? [String: Int])?["skippedDuplicateCount"], 1)
        XCTAssertEqual(snapshotCount, 2); XCTAssertEqual(sdk.fetches, 2)
        await core.close(); XCTAssertEqual(try rows().count, 2)
    }

    func testConcurrentManualRunsSerializeAndDoNotDuplicate() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first"), row("second")]
        let core = host(sdk); _ = try await core.start()
        async let first = core.importAppleReminders(); async let second = core.importAppleReminders()
        let answers = try await [first, second].map { try object($0) }
        let imported = answers.compactMap { ($0["result"] as? [String: Int])?["importedCount"] }.sorted()
        XCTAssertEqual(imported, [0, 2]); XCTAssertEqual(snapshotCount, 1)
        await core.close(); XCTAssertEqual(try rows().count, 2)
    }

    func testMidRunSaveFailureStopsAndColdRecoveryOnlySettlesAcceptedItem() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first"), row("second"), row("third")]
        let faults = HostIOFaults(), core = host(sdk, faults: faults); _ = try await core.start()
        var inserts = 0
        faults.beforeSQL = { sql in if sql.hasPrefix("INSERT INTO tasks") { inserts += 1; if inserts >= 2 { throw HostFailure("Held second item") } } }
        let interrupted = try object(await core.importAppleReminders())
        XCTAssertEqual(interrupted["kind"] as? String, "interrupted")
        XCTAssertEqual((interrupted["result"] as? [String: Int])?["importedCount"], 1)
        XCTAssertEqual((interrupted["result"] as? [String: Int])?["failedCount"], 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await core.close(); XCTAssertEqual(try rows().count, 1)
        let next = host(sdk); _ = try await next.start(); XCTAssertEqual(try rows().count, 2)
        XCTAssertEqual(sdk.fetches, 1, "Cold item recovery must not fetch or replay unaccepted provider rows")
        let resumed = try object(await next.importAppleReminders())
        XCTAssertEqual((resumed["result"] as? [String: Int])?["importedCount"], 1)
        XCTAssertEqual((resumed["result"] as? [String: Int])?["skippedDuplicateCount"], 2)
        await next.close(); XCTAssertEqual(try rows().count, 3)
    }

    func testAutomaticImportDoesNotPromptWhenPermissionIsUndetermined() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk, permission: .undetermined); _ = try await core.start()
        let result = try object(await core.importAppleReminders(automatic: true))
        XCTAssertEqual(result["kind"] as? String, "noop")
        XCTAssertEqual(sdk.requests, 0); XCTAssertEqual(sdk.listReads, 0); XCTAssertEqual(sdk.fetches, 0); XCTAssertEqual(snapshotCount, 0)
        await core.close()
    }

    func testDisabledAutomaticAndUnsupportedDeletionDoNotReadProvider() async throws {
        try settings(automatic: false, delete: true)
        let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        let result = try object(await core.importAppleReminders(automatic: true)); XCTAssertEqual(result["kind"] as? String, "noop")
        await refused { _ = try await core.importAppleReminders() }
        XCTAssertEqual(sdk.requests, 0); XCTAssertEqual(sdk.listReads, 0); XCTAssertEqual(sdk.fetches, 0); XCTAssertEqual(snapshotCount, 0)
        await core.close(); XCTAssertEqual(try rows().count, 0)
    }

    func testCloseCancelsHeldProviderReadAndCreatesNoTasks() async throws {
        let sdk = AppleRemindersTestSDK(), entered = expectation(description: "Read entered")
        sdk.beforeFetchReturn = { entered.fulfill() }
        let core = host(sdk); _ = try await core.start()
        let run = Task { try await core.importAppleReminders() }
        await fulfillment(of: [entered], timeout: 3)
        await core.close()
        await refused { _ = try await run.value }
        XCTAssertEqual(sdk.cancellations.count, 1); XCTAssertEqual(snapshotCount, 0); XCTAssertEqual(try rows().count, 0)
    }

    func testSourceListChangedBeforeReadSettlementPreventsImport() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first")]
        sdk.beforeFetchReturn = { sdk.listValues = [] }
        let core = host(sdk); _ = try await core.start()
        await refused { _ = try await core.importAppleReminders() }
        await core.close(); XCTAssertEqual(snapshotCount, 0); XCTAssertEqual(try rows().count, 0)
    }

    func testCancellationAfterAcceptedItemDoesNotStartNextItem() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first"), row("second")]
        let faults = HostIOFaults(), entered = expectation(description: "First item settled")
        let gate = DispatchSemaphore(value: 0); var held = false
        let core = host(sdk, faults: faults); _ = try await core.start()
        faults.journalRemove = {
            if !held {
                held = true; entered.fulfill()
                guard gate.wait(timeout: .now() + 5) == .success else { throw HostFailure("Test gate timed out") }
            }
        }
        let run = Task { try await core.importAppleReminders() }
        await fulfillment(of: [entered], timeout: 3)
        run.cancel(); gate.signal()
        await refused { _ = try await run.value }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); XCTAssertEqual(try rows().count, 1)
        let next = host(sdk); _ = try await next.start()
        let result = try object(await next.importAppleReminders())
        XCTAssertEqual((result["result"] as? [String: Int])?["importedCount"], 1)
        XCTAssertEqual((result["result"] as? [String: Int])?["skippedDuplicateCount"], 1)
        await next.close(); XCTAssertEqual(try rows().count, 2)
    }

    func testSnapshotFailureStopsBeforeAnyTaskMutation() async throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [row("first"), row("second")]
        let core = host(sdk); _ = try await core.start()
        let snapshots = root.appendingPathComponent("backup-snapshots")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: snapshots.path), [])
        try FileManager.default.removeItem(at: snapshots)
        try Data("Not a snapshot directory".utf8).write(to: snapshots)
        let result = try object(await core.importAppleReminders())
        XCTAssertEqual(result["kind"] as? String, "interrupted")
        XCTAssertEqual((result["result"] as? [String: Int])?["importedCount"], 0)
        XCTAssertEqual((result["result"] as? [String: Int])?["failedCount"], 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); XCTAssertEqual(try rows().count, 0)
    }

    func testNilProviderResultCreatesNoSnapshotOrTask() async throws {
        let sdk = AppleRemindersTestSDK(), entered = expectation(description: "Read entered")
        sdk.beforeFetchReturn = { entered.fulfill() }
        let core = host(sdk); _ = try await core.start()
        let run = Task { try await core.importAppleReminders() }
        await fulfillment(of: [entered], timeout: 3); sdk.deliver(nil)
        await refused { _ = try await run.value }
        await core.close(); XCTAssertEqual(snapshotCount, 0); XCTAssertEqual(try rows().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
