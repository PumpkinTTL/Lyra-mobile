package com.lyramobile

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.util.UUID

internal data class LyraAttachment(val name: String, val path: String, val mime: String, val size: Int)

internal class WorkspaceDocuments(private val resolver: ContentResolver, private val files: WorkspaceFiles) {
  private data class Item(val id: String, val name: String, val mime: String) {
    val directory get() = mime == DocumentsContract.Document.MIME_TYPE_DIR
  }

  private class ImportBudget(var remainingBytes: Int = 64 * 1024 * 1024, var remainingEntries: Int = 4096) {
    fun entry(amount: Int = 1) {
      remainingEntries -= amount
      require(remainingEntries >= 0) { "工作区包含超过 4096 个文件或目录。" }
    }
  }

  fun importTree(tree: Uri): LyraProject {
    val root = rootDocument(tree)
    val project = files.create(item(root).name)
    val budget = ImportBudget()
    try {
      copyFromTree(tree, DocumentsContract.getTreeDocumentId(tree), project.id, "", budget, 0)
    } catch (error: Exception) {
      files.discardNewProject(project.id)
      throw error
    }
    return project
  }

  private fun copyFromTree(tree: Uri, id: String, workspace: String, folder: String, budget: ImportBudget, depth: Int) {
    require(depth < 48) { "工作区目录层级过深。" }
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
    resolver.query(children, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        budget.entry()
        val child = Item(cursor.getString(0), cursor.getString(1), cursor.getString(2))
        val path = listOf(folder, WorkspaceFiles.validName(child.name)).filter { it.isNotEmpty() }.joinToString("/")
        if (child.directory) {
          files.mkdir(workspace, path)
          copyFromTree(tree, child.id, workspace, path, budget, depth + 1)
        } else {
          val uri = DocumentsContract.buildDocumentUriUsingTree(tree, child.id)
          val bytes = bytes(uri, minOf(budget.remainingBytes, WorkspaceFiles.MAX_FILE))
          budget.remainingBytes -= bytes.size
          files.write(workspace, path, bytes)
        }
      }
    } ?: error("无法读取选定目录。")
  }

  fun export(tree: Uri, workspace: String): String {
    val root = rootDocument(tree)
    val name = files.name(workspace)
    val destination = create(root, DocumentsContract.Document.MIME_TYPE_DIR, name)
    copyToTree(files.resolve(workspace, ""), destination)
    return item(destination).name
  }

  private fun copyToTree(folder: File, destination: Uri) {
    for (file in folder.listFiles().orEmpty()) {
      if (file.absoluteFile != file.canonicalFile) continue
      if (file.isDirectory) {
        copyToTree(file, create(destination, DocumentsContract.Document.MIME_TYPE_DIR, file.name))
      } else {
        val target = create(destination, mime(file.name), file.name)
        resolver.openOutputStream(target, "w")?.use { out -> file.inputStream().use { it.copyTo(out) } }
          ?: error("无法写入导出的文件：${file.name}")
      }
    }
  }

  fun attach(intent: Intent, workspace: String): List<LyraAttachment> {
    val clip = intent.clipData
    val uris = if (clip == null) listOfNotNull(intent.data) else (0 until clip.itemCount).map { clip.getItemAt(it).uri }.distinct()
    require(uris.size <= 6) { "一次最多添加 6 个附件。" }
    var remaining = 24 * 1024 * 1024
    val pending = uris.map { uri ->
      val name = documentName(uri)
      val path = ".attachments/${UUID.randomUUID()}/$name"
      val bytes = bytes(uri, minOf(remaining, WorkspaceFiles.MAX_FILE))
      remaining -= bytes.size
      Pair(LyraAttachment(name, path, resolver.getType(uri) ?: mime(name), bytes.size), bytes)
    }
    for ((entry, data) in pending) files.write(workspace, entry.path, data)
    return pending.map { it.first }
  }

  private fun bytes(uri: Uri, limit: Int): ByteArray {
    val bytes = resolver.openInputStream(uri)?.use { it.readUpTo(limit + 1) }
      ?: error("无法读取选定文件。")
    require(bytes.size <= limit) { "所选文件或目录超过可处理大小。" }
    return bytes
  }

  private fun documentName(uri: Uri): String {
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    } ?: "附件"
    return WorkspaceFiles.validName(name)
  }

  private fun item(uri: Uri): Item = resolver.query(uri, columns, null, null, null)?.use { cursor ->
    if (cursor.moveToFirst()) Item(cursor.getString(0), cursor.getString(1), cursor.getString(2)) else null
  } ?: error("无法获取文件或目录信息。")

  private fun rootDocument(tree: Uri): Uri =
    DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

  private fun create(directory: Uri, type: String, name: String): Uri =
    DocumentsContract.createDocument(resolver, directory, type, name) ?: error("无法创建文件：$name")

  companion object {
    private val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE)

    fun mime(name: String): String =
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
        ?: "application/octet-stream"
  }
}
