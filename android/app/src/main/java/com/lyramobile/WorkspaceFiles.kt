package com.lyramobile

import android.content.Context
import android.util.AtomicFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.UUID

internal data class LyraProject(val id: String, val name: String)
internal data class LyraEntry(val path: String, val directory: Boolean, val size: Long)

internal class WorkspaceFiles(context: Context) {
  private val projects = File(context.filesDir, "lyra-projects").apply { mkdirs() }
  private val names = File(context.filesDir, "lyra-project-names").apply { mkdirs() }

  init {
    File(projects, DEFAULT).mkdirs()
  }

  fun projects(): List<LyraProject> = projects.listFiles().orEmpty()
    .filter { it.isDirectory && validId(it.name) }
    .map { LyraProject(it.name, name(it.name)) }
    .sortedWith(compareBy({ it.id != DEFAULT }, { it.name }))

  fun name(id: String): String {
    root(id)
    return if (id == DEFAULT) "本机工作区" else File(names, id).takeIf { it.isFile }?.readText() ?: id
  }

  fun create(name: String): LyraProject {
    val label = validName(name.trim()).take(80)
    val id = UUID.randomUUID().toString()
    check(File(projects, id).mkdir()) { "无法创建工作区。" }
    File(names, id).writeText(label)
    return LyraProject(id, label)
  }

  fun discardNewProject(id: String) {
    require(id != DEFAULT)
    root(id).deleteRecursively()
    File(names, id).delete()
  }

  fun resolve(id: String, path: String): File {
    val base = root(id).canonicalFile
    require(!path.startsWith('/') && !path.contains('\\') && !path.contains('\u0000')) { "路径必须位于工作区。" }
    val segments = path.split('/').filter { it.isNotEmpty() && it != "." }
    val file = segments.fold(base) { parent, part -> File(parent, validName(part)) }.canonicalFile
    require(file == base || file.path.startsWith(base.path + File.separator)) { "路径超出工作区。" }
    return file
  }

  fun list(id: String, path: String, recursive: Boolean, limit: Int): Pair<List<LyraEntry>, Boolean> {
    val directory = resolve(id, path)
    require(directory.isDirectory) { "目录不存在：$path" }
    val entries = mutableListOf<LyraEntry>()
    val base = root(id).canonicalFile
    var truncated = false
    fun visit(folder: File) {
      for (file in folder.listFiles().orEmpty().sortedWith(compareBy({ !it.isDirectory }, { it.name }))) {
        if (entries.size >= limit) {
          truncated = true
          return
        }
        if (file.canonicalFile != file.absoluteFile) continue
        entries.add(LyraEntry(file.relativeTo(base).invariantSeparatorsPath, file.isDirectory, if (file.isFile) file.length() else 0))
        if (recursive && file.isDirectory) visit(file)
        if (truncated) return
      }
    }
    visit(directory)
    return Pair(entries, truncated)
  }

  fun read(id: String, path: String, limit: Int): Pair<ByteArray, Boolean> {
    val file = resolve(id, path)
    require(file.isFile) { "文件不存在：$path" }
    return Pair(file.inputStream().use { it.readUpTo(limit) }, file.length() > limit)
  }

  fun write(id: String, path: String, bytes: ByteArray) {
    require(bytes.size <= MAX_FILE) { "单个文件超过 16 MB。" }
    val file = resolve(id, path)
    require(!file.isDirectory) { "不能把目录当作文件写入：$path" }
    check(file.parentFile?.let { it.exists() || it.mkdirs() } == true) { "无法创建父目录。" }
    val atomic = AtomicFile(file)
    val stream = atomic.startWrite()
    try {
      stream.write(bytes)
      atomic.finishWrite(stream)
    } catch (error: Exception) {
      atomic.failWrite(stream)
      throw error
    }
  }

  fun mkdir(id: String, path: String) {
    val directory = resolve(id, path)
    check(directory.isDirectory || directory.mkdirs()) { "无法创建目录：$path" }
  }

  fun remove(id: String, path: String) {
    val file = resolve(id, path)
    require(file != root(id).canonicalFile) { "不能删除工作区根目录。" }
    check(!file.exists() || file.delete()) { "目录非空或无法删除：$path" }
  }

  private fun root(id: String): File {
    require(validId(id)) { "无效的工作区。" }
    val folder = File(projects, id)
    require(folder.isDirectory) { "工作区已不存在。" }
    return folder
  }

  companion object {
    const val DEFAULT = "default"
    const val MAX_FILE = 16 * 1024 * 1024
    private fun validId(value: String) = value == DEFAULT || value.matches(Regex("[a-f0-9-]{36}"))

    fun validName(value: String): String {
      require(value.isNotBlank() && value != "." && value != ".." && !value.contains('/') &&
        !value.contains('\\') && !value.contains('\u0000')) { "无效的文件或工作区名称。" }
      return value
    }
  }
}

internal fun InputStream.readUpTo(limit: Int): ByteArray {
  val buffer = ByteArray(8192)
  val out = ByteArrayOutputStream()
  while (out.size() < limit) {
    val count = read(buffer, 0, minOf(buffer.size, limit - out.size()))
    if (count < 0) break
    if (count > 0) out.write(buffer, 0, count)
  }
  return out.toByteArray()
}
