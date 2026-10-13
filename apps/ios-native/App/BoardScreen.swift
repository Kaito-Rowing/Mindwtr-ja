import SwiftUI
import UIKit

/// RN Board stacks full-width columns in a single vertical scroll.
struct BoardScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var searchFocused: Bool
    @State private var trackingAnchor = false
    private var bar: CoreObject { model.boardView.object("bar") }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Color.clear.frame(height: 0).id("board-top")
                        BoardReadFailure(model: model, palette: palette)
                        let columns = model.boardView.objects("columns")
                        ForEach(columns.indices, id: \.self) { index in column(columns[index]) }
                        if model.boardLoading || model.busy {
                            ProgressView().frame(maxWidth: .infinity).padding(12)
                                .accessibilityLabel(model.label("common.loading"))
                        }
                    }
                    .padding(16)
                }
                .coordinateSpace(name: "board-scroll")
                .accessibilityIdentifier("board-scroll")
                .scrollDismissesKeyboard(.interactively)
                .refreshable { endInput(); await model.refresh() }
                .onPreferenceChange(BoardRowFrames.self) { frames in
                    guard trackingAnchor, model.boardCurrent, !model.busy, !model.boardFiltersPresented,
                          !model.taskPresented, !model.areaPickerPresented else { return }
                    // Retain the first fully visible row/header. Rebuilding a
                    // fresh revision restores this ID instead of an old pixel offset.
                    if let first = frames.filter({ $0.value.minY >= 0 }).min(by: { $0.value.minY < $1.value.minY }) {
                        model.boardScrollAnchor = first.key
                    }
                }
                .task(id: model.boardCurrent) {
                    trackingAnchor = false
                    guard model.boardCurrent else { return }
                    let anchor = model.boardScrollAnchor
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    proxy.scrollTo(anchor, anchor: .top)
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    trackingAnchor = true
                }
                .onChange(of: model.boardScrollGeneration) { _ in proxy.scrollTo("board-top", anchor: .top) }
            }
        }
        .onChange(of: model.boardFiltersPresented) { if $0 { endInput() } }
        .onChange(of: model.areaPickerPresented) { if $0 { endInput() } }
        .onDisappear { trackingAnchor = false }
    }

    private var filterBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                TextField(bar.text("searchPlaceholder"), text: Binding(
                    get: { model.boardSearchText }, set: { model.setBoardSearch($0) }))
                    .rnFont(14).focused($searchFocused).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.search).onSubmit { endInput() }
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .accessibilityLabel(bar.text("searchPlaceholder")).accessibilityIdentifier("board-search")
                    .disabled(model.retryNeeded || model.boardActionPending)
                if !model.boardSearchText.isEmpty {
                    Button { model.setBoardSearch("") } label: {
                        AppIcon(name: "x", size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.retryNeeded || model.boardActionPending)
                    .accessibilityLabel(bar.text("clearLabel")).accessibilityIdentifier("board-search-clear")
                }
            }
            .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(bar.flag("searchActive") ? palette.tint : palette.border, lineWidth: 1))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if bar.flag("active") {
                    BoardButton(title: bar.text("clearLabel"), palette: palette, enabled: model.boardControlsEnabled,
                                id: "board-clear") { endInput(); model.editBoardFilters(["type": "clear"]) }
                }
                BoardButton(title: bar.text("filterLabel"), icon: "sliders", selected: bar.flag("active"),
                            palette: palette, enabled: model.boardControlsEnabled, id: "board-filter-open") {
                    endInput(); model.presentBoardFilters(true)
                }
            }
        }
        .padding(12).background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private func column(_ column: CoreObject) -> some View {
        let status = column.text("status")
        let color = tone(column.text("tone"))
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(column.text("label")).rnFont(15, .semibold).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("board-column-" + status)
                Text(String(column.number("count"))).rnFont(12, .semibold)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(color, lineWidth: 1))
                    .accessibilityIdentifier("board-count-" + status)
            }
            .padding(12).overlay(alignment: .bottom) { palette.border.frame(height: 1) }
            .id("board-column-" + status).background(anchor("board-column-" + status))
            VStack(alignment: .leading, spacing: 10) {
                let cards = column.objects("cards")
                ForEach(cards.indices, id: \.self) { index in card(cards[index]) }
                if cards.count < column.number("count") {
                    BoardButton(title: model.label("common.more"), palette: palette, enabled: model.boardActionsEnabled,
                                id: "board-more-" + status) { endInput(); model.loadMoreBoard("cards", status: status) }
                        .frame(maxWidth: .infinity)
                }
                if !column.text("empty").isEmpty {
                    Text(column.text("empty")).rnFont(13).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                }
            }.padding(10)
        }
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .top) { color.frame(height: 4).clipShape(RoundedRectangle(cornerRadius: 2)) }
    }

    private func card(_ item: CoreObject) -> some View {
        let row = item.object("row")
        let card = item.object("card")
        let id = row.text("id")
        let swipes = model.boardView.object("cardActions").object("swipes")
        let moveTo = model.boardView.object("cardActions").object("moveTo")
        return SwipeActionCard(
            palette: palette, enabled: model.boardActionsEnabled, id: "board-task-" + id,
            leftLabel: model.boardSwipeAction("left") == nil ? "" : swipes.object("left").text("label"),
            rightLabel: model.boardSwipeAction("right") == nil ? "" : swipes.object("right").text("label"),
            leftSystemImage: "doc.on.doc",
            open: { endInput(); Task { await model.openTask(id) } },
            swipe: { side in endInput(); Task { await model.performBoardSwipe(side, taskID: id) } },
            moveLabel: moveTo.text("label"), moveDestinations: model.boardMoveDestinations(item),
            move: { status in endInput(); Task { await model.moveBoardCard(item, status: status) } },
            content: VStack(alignment: .leading, spacing: 8) {
                Text(row.text("title")).rnFont(14, .medium).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if card.flag("showMetaRow") {
                    AppChipFlow {
                        if !card.text("projectTitle").isEmpty {
                            badge(card.text("projectTitle"), icon: "folder",
                                  color: card.text("projectColor").isEmpty ? palette.secondary : Color(hex: card.text("projectColor")))
                        }
                        let tokens = (card["tags"] as? [String] ?? []) + (card["contexts"] as? [String] ?? [])
                        ForEach(tokens.indices, id: \.self) { index in badge(tokens[index]) }
                        if !card.text("timeEstimateLabel").isEmpty { badge(card.text("timeEstimateLabel"), icon: "clock") }
                    }
                }
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        )
        .id("board-task-" + id).background(anchor("board-task-" + id))
    }

    private func badge(_ label: String, icon: String = "", color: Color? = nil) -> some View {
        HStack(spacing: 4) {
            if !icon.isEmpty { Image(systemName: icon).font(.system(size: 12)).accessibilityHidden(true) }
            Text(label).rnFont(11).lineLimit(1)
        }
        .foregroundStyle(palette.secondary).padding(.horizontal, 6).padding(.vertical, 2)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(color ?? palette.border, lineWidth: 1))
    }

    private func tone(_ name: String) -> Color {
        switch name {
        case "tint": return palette.tint
        case "warning": return palette.warning
        case "secondaryText": return palette.secondary
        case "success": return palette.success
        default: return palette.text
        }
    }

    private func anchor(_ id: String) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(key: BoardRowFrames.self, value: [id: geometry.frame(in: .named("board-scroll"))])
        }
    }

    private func endInput() {
        searchFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Observe horizontal drags alongside the Board's vertical ScrollView.
/// Like RN Swipeable, crossing the action threshold closes the panel and acts once.
struct SwipeActionCard<Content: View>: View {
    let palette: AppPalette
    let enabled: Bool
    let id: String
    let leftLabel: String
    let rightLabel: String
    let leftSystemImage: String
    let open: () -> Void
    let swipe: (String) -> Void
    var moveLabel: String = ""
    var moveDestinations: [CoreObject] = []
    var move: (String) -> Void = { _ in }
    let content: Content
    @GestureState private var offset: CGFloat = 0

    var body: some View {
        // A Button's touch-up can fire after a short simultaneous drag. Use a
        // distinct tap recognizer, while retaining the button's VoiceOver role.
        content
            .contentShape(Rectangle())
            .onTapGesture { if enabled { open() } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.default) { if enabled { open() } }
            .disabled(!enabled)
            .accessibilityIdentifier(id)
            .accessibilityActions {
                if !leftLabel.isEmpty { Button(leftLabel) { swipe("left") }.disabled(!enabled) }
                if !rightLabel.isEmpty { Button(rightLabel) { swipe("right") }.disabled(!enabled) }
                ForEach(moveDestinations.indices, id: \.self) { index in
                    let destination = moveDestinations[index]
                    Button(moveLabel + " " + destination.text("label")) { move(destination.text("status")) }
                        .disabled(!enabled)
                }
            }
            .contextMenu {
                if !leftLabel.isEmpty { Button(leftLabel, systemImage: leftSystemImage) { swipe("left") }.disabled(!enabled) }
                if !rightLabel.isEmpty {
                    Button(rightLabel, systemImage: "trash", role: .destructive) { swipe("right") }.disabled(!enabled)
                }
                if !moveDestinations.isEmpty {
                    Menu(moveLabel) {
                        ForEach(moveDestinations.indices, id: \.self) { index in
                            let destination = moveDestinations[index]
                            Button(destination.text("label")) { move(destination.text("status")) }
                                .accessibilityIdentifier("board-move-" + destination.text("status"))
                                .disabled(!enabled)
                        }
                    }
                    .accessibilityIdentifier("board-move-menu-" + id)
                    .disabled(!enabled)
                }
            }
            .offset(x: offset)
            .background {
                if offset != 0 {
                    HStack(spacing: 0) {
                        if offset > 0 { panel(leftLabel, color: palette.tint) }
                        Spacer(minLength: 0)
                        if offset < 0 { panel(rightLabel, color: palette.danger) }
                    }.accessibilityHidden(true)
                }
            }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .updating($offset) { value, offset, _ in
                    let delta = value.translation
                    guard enabled, abs(delta.width) > abs(delta.height) * 1.5,
                          !(delta.width > 0 ? leftLabel : rightLabel).isEmpty else { return }
                    offset = max(-112, min(112, delta.width))
                }
                .onEnded { value in
                    let delta = value.translation
                    guard enabled, abs(delta.width) >= 72, abs(delta.width) > abs(delta.height) * 1.5 else { return }
                    let side = delta.width > 0 ? "left" : "right"
                    guard !(side == "left" ? leftLabel : rightLabel).isEmpty else { return }
                    swipe(side)
                },
            including: enabled ? .all : .none
        )
    }

    private func panel(_ label: String, color: Color) -> some View {
        Text(label).rnFont(14, .semibold).multilineTextAlignment(.center)
            .padding(.horizontal, 8).frame(width: 112).frame(maxHeight: .infinity)
            .foregroundStyle(palette.text).background(palette.bg)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 1))
    }
}

struct BoardFiltersSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var picker = ""
    @State private var dueExpanded = false
    @FocusState private var pickerSearchFocused: Bool
    private var sheet: CoreObject { model.boardView.object("sheet") }
    private var filters: CoreObject { model.boardView.object("filters") }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { dismiss() } label: { Color.black.opacity(0.35).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("board-filter-dismiss")
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        if !picker.isEmpty {
                            BoardButton(title: model.label("common.back"), palette: palette, id: "board-picker-back") { back() }
                        }
                        Text(model.label(picker.isEmpty ? "filters.label" : picker == "tokens" ? "filters.contexts" : "filters.projects"))
                            .rnFont(16, .bold).frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("board-filter-title")
                    }
                    if !picker.isEmpty {
                        pickerSearch
                        BoardReadFailure(model: model, palette: palette)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if picker.isEmpty { overview }
                            else { pickerOptions }
                            if picker.isEmpty { BoardReadFailure(model: model, palette: palette) }
                            if model.boardLoading { ProgressView().frame(maxWidth: .infinity) }
                        }.padding(.bottom, 12)
                    }.accessibilityIdentifier("board-filter-scroll").scrollDismissesKeyboard(.interactively)
                    HStack {
                        BoardButton(title: model.label("filters.clear"), palette: palette, enabled: model.boardControlsEnabled,
                                    id: "board-filter-clear") { model.editBoardFilters(["type": "clear"]) }
                        Spacer(minLength: 8)
                        BoardButton(title: model.label("common.done"), palette: palette, id: "board-filter-close") {
                            dismiss()
                        }
                    }
                }
                .padding(16).frame(maxWidth: 860, maxHeight: geometry.size.height * 0.82)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) {
                if picker.isEmpty { dismiss() } else { back() }
            }
        }
        .onDisappear { pickerSearchFocused = false; model.closeBoardPicker() }
    }

    private func openPicker(_ name: String) {
        model.openBoardPicker(name)
        picker = name
    }

    private func back() {
        pickerSearchFocused = false
        model.closeBoardPicker()
        picker = ""
    }

    private func dismiss() {
        pickerSearchFocused = false
        model.presentBoardFilters(false)
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            let chips = sheet.object("chips").objects("items") + sheet.objects("additionalChips")
            if !chips.isEmpty {
                Text(model.label("filters.active")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                AppChipFlow {
                    ForEach(chips.indices, id: \.self) { index in
                        let chip = chips[index]
                        BoardButton(title: chip.text("label"), icon: "x", selected: true, excluded: chip.flag("excluded"),
                                    palette: palette, enabled: model.boardControlsEnabled,
                                    id: "board-filter-chip-" + chip.text("id")) { model.editBoardFilters(chip.object("edit")) }
                            .accessibilityLabel(model.label("filters.remove") + ": " + chip.text("label"))
                    }
                }
                more("chips")
            }
            let due = sheet.object("due")
            Button { dueExpanded.toggle() } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(due.text("label")).rnFont(15, .medium)
                        Text(due.text("summary")).rnFont(13).foregroundStyle(palette.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Text(dueExpanded ? "−" : "+").rnFont(20)
                }
                .padding(14).frame(minHeight: 60).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(due.text("accessibilityLabel"))
            .accessibilityValue(dueExpanded ? "1" : "0").accessibilityIdentifier("board-filter-due")
            if dueExpanded {
                AppChipFlow {
                    let presets = due.objects("presets")
                    ForEach(presets.indices, id: \.self) { index in
                        let preset = presets[index]
                        BoardButton(title: preset.text("label"), selected: preset.flag("selected"), palette: palette,
                                    enabled: model.boardControlsEnabled, id: "board-due-" + preset.text("preset")) {
                            model.editBoardFilters(["type": "toggleDuePreset", "preset": preset.text("preset")])
                        }
                    }
                }
            }
            BoardButton(title: model.label("filters.contexts"), palette: palette, enabled: model.boardControlsEnabled,
                        id: "board-picker-tokens") { openPicker("tokens") }
            BoardButton(title: model.label("filters.projects"), palette: palette, enabled: model.boardControlsEnabled,
                        id: "board-picker-projects") { openPicker("projects") }
        }
    }

    private var pickerOptions: some View {
        VStack(alignment: .leading, spacing: 0) {
            let options = sheet.object(picker).objects("items")
            if model.boardCurrent && options.isEmpty {
                Text(model.label("search.noResults")).rnFont(14).foregroundStyle(palette.secondary)
                    .padding(.vertical, 28)
                    .accessibilityIdentifier("board-picker-empty")
            }
            Group {
                ForEach(options.indices, id: \.self) { index in
                    let item = options[index]
                    let token = picker == "tokens"
                    let selected = token ? item.text("state") == "included" : item.flag("selected")
                    let excluded = token && item.text("state") == "excluded"
                    let value = item.text(token ? "value" : "id")
                    Button { model.editBoardFilters(["type": token ? "toggleToken" : "toggleProject", "value": value]) } label: {
                        HStack(spacing: 12) {
                            Text(item.text(token ? "value" : "title")).rnFont(14).strikethrough(excluded)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
                            if excluded { Text(model.label("filters.excluded")).rnFont(12, .semibold) }
                        }
                        .foregroundStyle(excluded ? palette.danger : selected ? palette.tint : palette.text)
                        .padding(.horizontal, 4).padding(.vertical, 8).frame(minHeight: 52).contentShape(Rectangle())
                        .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
                    }
                    .buttonStyle(.plain).disabled(!model.boardControlsEnabled)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityValue(excluded ? model.label("filters.excluded") : selected ? "1" : "0")
                    .accessibilityIdentifier("board-filter-" + (token ? "token-" : "project-") + value)
                }
                more(picker)
                if picker == "tokens" {
                    if sheet.flag("showContextMatchMode") { matchMode("context") }
                    if sheet.flag("showTagMatchMode") { matchMode("tag") }
                }
            }.disabled(!model.boardCurrent)
        }
    }

    private var pickerSearch: some View {
        TextField(model.label("common.search"), text: Binding(
            get: { model.boardPickerQuery }, set: { model.setBoardPickerQuery($0) }))
            .rnFont(15).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.search).focused($pickerSearchFocused).onSubmit { pickerSearchFocused = false }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .disabled(model.retryNeeded || model.boardActionPending)
            .accessibilityLabel(model.label("common.search") + " " + model.label(picker == "tokens" ? "filters.contexts" : "filters.projects"))
            .accessibilityIdentifier("board-picker-search")
    }

    @ViewBuilder private func more(_ list: String) -> some View {
        let window = sheet.object(list)
        if window.objects("items").count < window.number("total") {
            BoardButton(title: model.label("common.more"), palette: palette, enabled: model.boardControlsEnabled && model.boardCurrent,
                        id: "board-more-" + list) { model.loadMoreBoard(list) }.frame(maxWidth: .infinity)
        }
    }

    private func matchMode(_ kind: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.label(kind == "context" ? "filters.contextMatchMode" : "filters.tagMatchMode"))
                .rnFont(12, .semibold).foregroundStyle(palette.secondary)
            AppChipFlow {
                ForEach(["any", "all"], id: \.self) { mode in
                    BoardButton(title: model.label(mode == "any" ? "filters.matchAny" : "common.all"),
                                selected: filters.text(kind + "MatchMode") == mode, palette: palette,
                                enabled: model.boardControlsEnabled, id: "board-match-" + kind + "-" + mode) {
                        model.editBoardFilters(["type": "setMatchMode", "kind": kind, "value": mode])
                    }
                }
            }
        }.padding(.vertical, 12)
    }
}

private struct BoardReadFailure: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var body: some View {
        if let error = model.boardError {
            VStack(alignment: .leading, spacing: 8) {
                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityIdentifier("board-error")
                BoardButton(title: model.label("common.retry"), palette: palette, enabled: !model.busy && !model.retryNeeded,
                            id: "board-retry") { model.retryBoard() }
            }
        }
    }
}

private struct BoardButton: View {
    let title: String
    var icon = ""
    var selected = false
    var excluded = false
    let palette: AppPalette
    var enabled = true
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if !icon.isEmpty { AppIcon(name: icon, size: 14) }
                Text(title).rnFont(13, .semibold).strikethrough(excluded)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(excluded ? palette.danger : selected ? palette.onTint : palette.text)
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 44)
            .background(selected && !excluded ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(excluded ? palette.danger : selected ? palette.tint : palette.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct BoardRowFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}
