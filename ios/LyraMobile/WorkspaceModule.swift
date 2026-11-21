import Foundation
import PDFKit
import QuickLook
import React
import UIKit
import UniformTypeIdentifiers

@objc(LyraWorkspace)
final class WorkspaceModule: NSObject, UIDocumentPickerDelegate, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private enum Picker { case importFolder, attach(String), export(URL, String, URL) }
  private let worker = DispatchQueue(label: "com.lyramobile.workspace")
  private let fm = FileManager.default
  private let limit = 16 * 1024 * 1024
  private var pending: (Picker, RCTPromiseResolveBlock, RCTPromiseRejectBlock)?
  private var preview: URL?

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func issue(_ message: String) -> NSError {
    NSError(domain: "LyraWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func perform(_ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, _ job: @escaping () throws -> Any?) {
    worker.async {
      do { resolve(try job()) } catch { reject("LYRA_WORKSPACE", error.localizedDescription, error) }
    }
  }

  private var base: URL { fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Lyra", isDirectory: true) }
  private var projects: URL { base.appendingPathComponent("Workspace", isDirectory: true) }
  private var labels: URL { base.appendingPathComponent("WorkspaceNames", isDirectory: true) }

  private func validId(_ id: String) -> Bool { id.range(of: "^[a-z0-9-]{4,80}$", options: .regularExpression) != nil }

  private func validName(_ name: String) throws -> String {
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"), !name.contains("\0"), name.utf8.count <= 255 else {
      throw issue("无效的文件名。")
    }
    return name
  }

  private func mkdir(_ url: URL) throws { try fm.createDirectory(at: url, withIntermediateDirectories: true) }

  private func root(_ id: String) throws -> URL {
    guard validId(id) else { throw issue("无效的工作区 ID。") }
    let root = projects.appendingPathComponent(id, isDirectory: true)
    if id == "default" { try mkdir(root) }
    var directory: ObjCBool = false
    guard fm.fileExists(atPath: root.path, isDirectory: &directory), directory.boolValue else { throw issue("工作区不存在。") }
    return root.resolvingSymlinksInPath().standardizedFileURL
  }

  private func resolvePath(_ id: String, _ path: String) throws -> URL {
    guard !path.hasPrefix("/") else { throw issue("路径必须位于当前工作区。") }
    let root = try root(id)
    let file = try path.split(separator: "/").reduce(root) { url, part in
      if part == "." { return url }
      return url.appendingPathComponent(try validName(String(part)))
    }.resolvingSymlinksInPath().standardizedFileURL
    guard file.path == root.path || file.path.hasPrefix(root.path + "/") else { throw issue("路径必须位于当前工作区。") }
    return file
  }

  private func existingFile(_ id: String, _ path: String) throws -> URL {
    let url = try resolvePath(id, path)
    guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw issue("文件不存在：\(path)") }
    return url
  }

  private func projectName(_ id: String) -> String {
    if id == "default" { return "本机工作区" }
    return (try? String(contentsOf: labels.appendingPathComponent(id), encoding: .utf8)) ?? id
  }

  private func create(_ name: String) throws -> [String: String] {
    let clean = try validName(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)))
    let id = UUID().uuidString.lowercased()
    let directory = projects.appendingPathComponent(id, isDirectory: true)
    try mkdir(directory)
    do {
      try mkdir(labels)
      try Data(clean.utf8).write(to: labels.appendingPathComponent(id), options: .atomic)
    } catch { try? fm.removeItem(at: directory); throw error }
    return ["id": id, "name": clean]
  }

  @objc func listProjects(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      _ = try self.root("default")
      let dirs = try self.fm.contentsOfDirectory(at: self.projects, includingPropertiesForKeys: [.isDirectoryKey])
      return dirs.filter { self.validId($0.lastPathComponent) && (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        .map(\.lastPathComponent).sorted { a, b in a == "default" || (b != "default" && self.projectName(a) < self.projectName(b)) }
        .map { ["id": $0, "name": self.projectName($0)] }
    }
  }

  @objc func createProject(_ name: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) { try self.create(name) }
  }

  @objc func list(_ id: String, path: String, recursive: Bool, limit maximum: Int, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let folder = try self.resolvePath(id, path)
      let root = try self.root(id).path + "/"
      let maximum = min(max(1, maximum), 8192)
      let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      var entries: [[String: Any]] = []
      var truncated = false
      func visit(_ url: URL, depth: Int) throws {
        guard depth <= 48 else { truncated = true; return }
        let children = try self.fm.contentsOfDirectory(at: url, includingPropertiesForKeys: keys)
        for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
          let values = try child.resourceValues(forKeys: Set(keys))
          guard values.isSymbolicLink != true, values.isDirectory == true || values.isRegularFile == true else { continue }
          if entries.count >= maximum { truncated = true; return }
          entries.append(["path": String(child.path.dropFirst(root.count)), "directory": values.isDirectory == true, "size": values.fileSize ?? 0])
          if recursive, values.isDirectory == true { try visit(child, depth: depth + 1) }
          if truncated { return }
        }
      }
      try visit(folder, depth: 0)
      return ["entries": entries, "truncated": truncated]
    }
  }

  private func readBytes(_ file: URL, _ count: Int) throws -> Data {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    return try handle.read(upToCount: count) ?? Data()
  }

  private func mime(_ url: URL) -> String { UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream" }

  @objc func read(_ id: String, path: String, limit maximum: Int, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try self.existingFile(id, path)
      let maximum = min(max(1, maximum), self.limit)
      let bytes = try self.readBytes(url, maximum + 1)
      return ["base64": bytes.prefix(maximum).base64EncodedString(), "mime": self.mime(url), "truncated": bytes.count > maximum]
    }
  }

  @objc func write(_ id: String, path: String, value: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard let data = Data(base64Encoded: value), data.count <= self.limit else { throw self.issue("文件无效或超过 16 MB。") }
      let url = try self.resolvePath(id, path)
      try self.mkdir(url.deletingLastPathComponent())
      try data.write(to: url, options: .atomic)
      return nil
    }
  }

  @objc func mkdir(_ id: String, path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) { try self.mkdir(self.resolvePath(id, path)); return nil }
  }

  @objc func remove(_ id: String, path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try self.resolvePath(id, path)
      guard try url != self.root(id) else { throw self.issue("不能删除工作区根目录。") }
      if self.fm.fileExists(atPath: url.path) {
        if try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true,
           try !self.fm.contentsOfDirectory(atPath: url.path).isEmpty { throw self.issue("目录非空。") }
        try self.fm.removeItem(at: url)
      }
      return nil
    }
  }

  private func transcript(_ id: String) throws -> URL {
    guard validId(id) else { throw issue("无效的对话 ID。") }
    let directory = base.appendingPathComponent("Chat", isDirectory: true)
    try mkdir(directory)
    return directory.appendingPathComponent(id + ".json")
  }

  @objc func loadTranscript(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try self.transcript(id)
      return self.fm.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : nil
    }
  }

  @objc func saveTranscript(_ id: String, json: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard json.utf8.count <= 48 * 1024 * 1024 else { throw self.issue("对话记录过大。") }
      try Data(json.utf8).write(to: self.transcript(id), options: .atomic)
      return nil
    }
  }

  @objc func removeTranscript(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try self.transcript(id)
      if self.fm.fileExists(atPath: url.path) { try self.fm.removeItem(at: url) }
      return nil
    }
  }

  private func present(_ picker: UIDocumentPickerViewController, _ mode: Picker, _ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock) {
    guard pending == nil, let host = RCTPresentedViewController() else {
      if case let .export(_, _, folder) = mode { try? fm.removeItem(at: folder) }
      reject("LYRA_PICKER", "当前无法打开文件选择器。", nil)
      return
    }
    pending = (mode, resolve, reject)
    picker.delegate = self
    host.present(picker, animated: true)
  }

  @objc func importProject(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { self.present(UIDocumentPickerViewController(forOpeningContentTypes: [.folder]), .importFolder, resolve, reject) }
  }

  @objc func pickAttachments(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      picker.allowsMultipleSelection = true
      self.present(picker, .attach(id), resolve, reject)
    }
  }

  private func export(_ source: @escaping () throws -> (URL, String), _ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock) {
    worker.async {
      let temp = self.fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
      do {
        let (original, name) = try source()
        try self.mkdir(temp)
        let file = temp.appendingPathComponent(try self.validName(name))
        try self.fm.copyItem(at: original, to: file)
        DispatchQueue.main.async {
          self.present(UIDocumentPickerViewController(forExporting: [file], asCopy: true), .export(file, name, temp), resolve, reject)
        }
      } catch { try? self.fm.removeItem(at: temp); reject("LYRA_EXPORT", error.localizedDescription, error) }
    }
  }

  @objc func exportProject(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    export({ (try self.root(id), self.projectName(id)) }, resolve, reject)
  }

  @objc func saveFile(_ id: String, path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    export({ let file = try self.existingFile(id, path); return (file, file.lastPathComponent) }, resolve, reject)
  }

  private func copiedFolder(_ source: URL) throws -> [String: String] {
    let project = try create(source.lastPathComponent)
    guard let id = project["id"] else { throw issue("无法创建工作区。") }
    let destination = try root(id)
    var byteBudget = 64 * 1024 * 1024
    var entryBudget = 4096
    let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
    func copy(_ from: URL, _ to: URL, _ depth: Int) throws {
      guard depth <= 48 else { throw issue("文件夹嵌套过深。") }
      for child in try fm.contentsOfDirectory(at: from, includingPropertiesForKeys: keys) {
        let values = try child.resourceValues(forKeys: Set(keys))
        guard values.isSymbolicLink != true else { continue }
        entryBudget -= 1
        guard entryBudget >= 0 else { throw issue("文件夹最多可导入 4096 项。") }
        let target = to.appendingPathComponent(try validName(child.lastPathComponent))
        if values.isDirectory == true {
          try mkdir(target)
          try copy(child, target, depth + 1)
        } else if values.isRegularFile == true {
          let bytes = try readBytes(child, min(byteBudget, limit) + 1)
          guard bytes.count <= min(byteBudget, limit) else { throw issue("文件夹超过工作区导入大小。") }
          byteBudget -= bytes.count
          try bytes.write(to: target, options: .atomic)
        }
      }
    }
    do { try copy(source, destination, 0); return project }
    catch { try? fm.removeItem(at: destination); try? fm.removeItem(at: labels.appendingPathComponent(id)); throw error }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let (mode, resolve, reject) = pending else { return }
    pending = nil
    perform(resolve, reject) {
      switch mode {
      case let .export(_, name, directory):
        try? self.fm.removeItem(at: directory)
        return urls.isEmpty ? nil : name
      case .importFolder:
        guard let url = urls.first else { return nil }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var result: Result<[String: String], Error>?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { item in
          result = Result { try self.copiedFolder(item) }
        }
        if let error = coordinationError { throw error }
        return try result?.get()
      case let .attach(id):
        guard urls.count <= 6 else { throw self.issue("一次最多选择 6 个附件。") }
        var remaining = 24 * 1024 * 1024
        var saved: [URL] = []
        do {
          return try urls.map { url -> [String: Any] in
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let name = try self.validName(url.lastPathComponent)
            let path = ".attachments/\(UUID().uuidString.lowercased())/\(name)"
            let file = try self.resolvePath(id, path)
            let bytes = try self.readBytes(url, min(remaining, self.limit) + 1)
            guard bytes.count <= min(remaining, self.limit) else { throw self.issue("附件超过大小限制。") }
            remaining -= bytes.count
            try self.mkdir(file.deletingLastPathComponent())
            saved.append(file.deletingLastPathComponent())
            try bytes.write(to: file, options: .atomic)
            return ["name": name, "path": path, "mime": self.mime(url), "size": bytes.count]
          }
        } catch { for folder in saved { try? self.fm.removeItem(at: folder) }; throw error }
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard let (mode, resolve, _) = pending else { return }
    pending = nil
    if case let .export(_, _, directory) = mode { worker.async { try? self.fm.removeItem(at: directory) } }
    resolve(nil)
  }

  private func presentFile(_ id: String, _ path: String, _ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, _ action: @escaping (UIViewController, URL) throws -> Void) {
    worker.async {
      do {
        let file = try self.existingFile(id, path)
        DispatchQueue.main.async {
          guard let host = RCTPresentedViewController() else { reject("LYRA_FILE", "请先打开 Lyra。", nil); return }
          do { try action(host, file); resolve(nil) }
          catch { reject("LYRA_FILE", error.localizedDescription, error) }
        }
      } catch { reject("LYRA_FILE", error.localizedDescription, error) }
    }
  }

  @objc func shareFile(_ id: String, path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    presentFile(id, path, resolve, reject) { host, url in
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      sheet.popoverPresentationController?.sourceView = host.view
      sheet.popoverPresentationController?.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
      host.present(sheet, animated: true)
    }
  }

  @objc func openFile(_ id: String, path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    presentFile(id, path, resolve, reject) { host, url in
      guard QLPreviewController.canPreview(url as NSURL) else { throw self.issue("系统预览不支持此文件。可以继续使用内置预览或另存文件。") }
      self.preview = url
      let controller = QLPreviewController()
      controller.dataSource = self
      controller.delegate = self
      host.present(controller, animated: true)
    }
  }

  @objc func pdfPage(_ id: String, path: String, page index: Int, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try self.existingFile(id, path)
      guard url.pathExtension.lowercased() == "pdf", let document = PDFDocument(url: url), !document.isLocked,
            index >= 0, index < document.pageCount, let page = document.page(at: index) else { throw self.issue("无法读取此 PDF 页。") }
      let size = page.bounds(for: .cropBox).size
      guard size.width > 0, size.height > 0, size.width.isFinite, size.height.isFinite else { throw self.issue("PDF 页尺寸无效。") }
      let scale = min(2.75, 1700 / max(size.width, size.height))
      let image = page.thumbnail(of: CGSize(width: size.width * scale, height: size.height * scale), for: .cropBox)
      guard let png = image.pngData() else { throw self.issue("无法渲染 PDF 页。") }
      return ["count": document.pageCount, "base64": png.base64EncodedString()]
    }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { preview == nil ? 0 : 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { (preview ?? base) as NSURL }
  func previewControllerDidDismiss(_ controller: QLPreviewController) { preview = nil }

  @objc func copyText(_ text: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { UIPasteboard.general.string = text; resolve(nil) }
  }
}
