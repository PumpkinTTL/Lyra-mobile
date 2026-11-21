package com.lyramobile

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.AtomicFile
import java.io.ByteArrayOutputStream
import java.io.File
import android.util.Base64
import androidx.core.content.FileProvider
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.util.concurrent.Executors

internal class WorkspacePackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(WorkspaceModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

internal class WorkspaceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val files = WorkspaceFiles(context)
  private val documents = WorkspaceDocuments(context.contentResolver, files)
  private val io = Executors.newSingleThreadExecutor()
  private val transcripts = File(context.filesDir, "lyra-conversations").apply { mkdirs() }
  private var picker: Picker? = null
  private data class Picker(val type: Int, val workspace: String, val path: String, val promise: Promise)

  init {
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        val operation = picker ?: return
        if (operation.type != requestCode) return
        picker = null
        if (resultCode != Activity.RESULT_OK || data == null) {
          operation.promise.resolve(null)
          return
        }
        work(operation.promise) {
          when (requestCode) {
            PICK_IMPORT -> project(documents.importTree(requireNotNull(data.data)))
            PICK_EXPORT -> documents.export(requireNotNull(data.data), operation.workspace)
            PICK_SAVE -> {
              val source = existingFile(operation.workspace, operation.path)
              context.contentResolver.openOutputStream(requireNotNull(data.data), "w")?.use { output ->
                source.inputStream().use { it.copyTo(output) }
              } ?: error("无法写入选定位置。")
              source.name
            }
            PICK_ATTACH -> Arguments.createArray().apply {
              for (item in documents.attach(data, operation.workspace)) pushMap(Arguments.createMap().apply {
                putString("name", item.name)
                putString("path", item.path)
                putString("mime", item.mime)
                putInt("size", item.size)
              })
            }
            else -> error("未知的文件操作。")
          }
        }
      }
    })
  }

  override fun getName() = "LyraWorkspace"

  private fun work(promise: Promise, task: () -> Any?) {
    io.execute {
      try {
        promise.resolve(task())
      } catch (error: Exception) {
        promise.reject("LYRA_WORKSPACE", error.message ?: "工作区操作失败。")
      }
    }
  }

  private fun project(item: LyraProject): WritableMap = Arguments.createMap().apply {
    putString("id", item.id)
    putString("name", item.name)
  }

  private fun pick(type: Int, workspace: String, intent: Intent, promise: Promise, path: String = "") {
    val activity = context.currentActivity
    if (activity == null) {
      promise.reject("LYRA_PICKER", "请先打开 Lyra。")
      return
    }
    activity.runOnUiThread {
      if (picker != null) {
        promise.reject("LYRA_PICKER", "已有文件选择操作正在进行。")
        return@runOnUiThread
      }
      picker = Picker(type, workspace, path, promise)
      try {
        activity.startActivityForResult(intent, type)
      } catch (error: Exception) {
        picker = null
        promise.reject("LYRA_PICKER", error.message ?: "无法打开系统文件选择器。")
      }
    }
  }

  @ReactMethod
  fun listProjects(promise: Promise) = work(promise) {
    Arguments.createArray().apply { for (item in files.projects()) pushMap(project(item)) }
  }

  @ReactMethod
  fun createProject(name: String, promise: Promise) = work(promise) { project(files.create(name)) }

  @ReactMethod
  fun importProject(promise: Promise) = pick(PICK_IMPORT, "", Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), promise)

  @ReactMethod
  fun exportProject(workspace: String, promise: Promise) =
    pick(PICK_EXPORT, workspace, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), promise)

  @ReactMethod
  fun pickAttachments(workspace: String, promise: Promise) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    pick(PICK_ATTACH, workspace, intent, promise)
  }

  private fun existingFile(workspace: String, path: String): File = files.resolve(workspace, path).also {
    require(it.isFile) { "文件不存在：$path" }
  }

  private fun presentFile(workspace: String, path: String, share: Boolean, promise: Promise) {
    io.execute {
      try {
        val file = existingFile(workspace, path)
        val uri = FileProvider.getUriForFile(context, context.packageName + ".workspace.files", file)
        val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
          val mime = WorkspaceDocuments.mime(path)
          if (share) {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
          } else setDataAndType(uri, mime)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          clipData = ClipData.newUri(context.contentResolver, file.name, uri)
        }
        val activity = context.currentActivity ?: error("请先打开 Lyra。")
        activity.runOnUiThread {
          try {
            activity.startActivity(Intent.createChooser(intent, if (share) "分享文件" else "选择打开方式"))
            promise.resolve(null)
          } catch (error: Exception) { promise.reject("LYRA_FILE", error) }
        }
      } catch (error: Exception) { promise.reject("LYRA_FILE", error) }
    }
  }

  @ReactMethod
  fun shareFile(workspace: String, path: String, promise: Promise) = presentFile(workspace, path, true, promise)

  @ReactMethod
  fun openFile(workspace: String, path: String, promise: Promise) = presentFile(workspace, path, false, promise)

  @ReactMethod
  fun saveFile(workspace: String, path: String, promise: Promise) {
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = WorkspaceDocuments.mime(path)
      putExtra(Intent.EXTRA_TITLE, path.substringAfterLast('/'))
    }
    pick(PICK_SAVE, workspace, intent, promise, path)
  }

  @ReactMethod
  fun copyText(text: String, promise: Promise) {
    val activity = context.currentActivity
    if (activity == null) { promise.reject("LYRA_CLIPBOARD", "请先打开 Lyra。"); return }
    activity.runOnUiThread {
      try {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Lyra", text))
        promise.resolve(null)
      } catch (error: Exception) { promise.reject("LYRA_CLIPBOARD", error) }
    }
  }

  @ReactMethod
  fun pdfPage(workspace: String, path: String, page: Int, promise: Promise) = work(promise) {
    val source = existingFile(workspace, path)
    require(source.extension.equals("pdf", ignoreCase = true)) { "请选择 PDF 文件。" }
    val descriptor = ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY)
    val renderer = try { PdfRenderer(descriptor) } catch (error: Exception) { descriptor.close(); throw error }
    renderer.use {
      require(page in 0 until it.pageCount) { "PDF 页码超出范围。" }
      it.openPage(page).use { frame ->
        val scale = minOf(1.75, 1080.0 / maxOf(frame.width, frame.height))
        val bitmap = Bitmap.createBitmap((frame.width * scale).toInt().coerceAtLeast(1), (frame.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        try {
          bitmap.eraseColor(Color.WHITE)
          val transform = Matrix().apply { setScale(scale.toFloat(), scale.toFloat()) }
          frame.render(bitmap, null, transform, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          val bytes = ByteArrayOutputStream().apply { bitmap.compress(Bitmap.CompressFormat.PNG, 100, this) }
          Arguments.createMap().apply {
            putInt("count", it.pageCount)
            putString("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
          }
        } finally { bitmap.recycle() }
      }
    }
  }

  @ReactMethod
  fun list(workspace: String, path: String, recursive: Boolean, limit: Int, promise: Promise) = work(promise) {
    val (entries, truncated) = files.list(workspace, path, recursive, limit.coerceIn(1, 8192))
    Arguments.createMap().apply {
      putBoolean("truncated", truncated)
      putArray("entries", Arguments.createArray().apply {
        for (item in entries) pushMap(Arguments.createMap().apply {
          putString("path", item.path)
          putBoolean("directory", item.directory)
          putDouble("size", item.size.toDouble())
        })
      })
    }
  }

  @ReactMethod
  fun read(workspace: String, path: String, limit: Int, promise: Promise) = work(promise) {
    val (bytes, truncated) = files.read(workspace, path, limit.coerceIn(1, WorkspaceFiles.MAX_FILE))
    Arguments.createMap().apply {
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      putString("mime", WorkspaceDocuments.mime(path))
      putBoolean("truncated", truncated)
    }
  }

  @ReactMethod
  fun write(workspace: String, path: String, value: String, promise: Promise) = work(promise) {
    files.write(workspace, path, Base64.decode(value, Base64.NO_WRAP))
    null
  }

  @ReactMethod
  fun mkdir(workspace: String, path: String, promise: Promise) = work(promise) {
    files.mkdir(workspace, path)
    null
  }

  @ReactMethod
  fun remove(workspace: String, path: String, promise: Promise) = work(promise) {
    files.remove(workspace, path)
    null
  }

  private fun transcript(id: String): File {
    require(id.matches(Regex("[a-z0-9-]{4,80}"))) { "无效的对话 ID。" }
    return File(transcripts, id + ".json")
  }

  @ReactMethod
  fun loadTranscript(id: String, promise: Promise) = work(promise) {
    transcript(id).takeIf { it.isFile }?.readText()
  }

  @ReactMethod
  fun saveTranscript(id: String, json: String, promise: Promise) = work(promise) {
    val bytes = json.toByteArray(Charsets.UTF_8)
    require(bytes.size <= 48 * 1024 * 1024) { "对话记录过大，请新建对话继续。" }
    val file = AtomicFile(transcript(id))
    val stream = file.startWrite()
    try {
      stream.write(bytes)
      file.finishWrite(stream)
    } catch (error: Exception) {
      file.failWrite(stream)
      throw error
    }
    null
  }

  @ReactMethod
  fun removeTranscript(id: String, promise: Promise) = work(promise) {
    AtomicFile(transcript(id)).delete()
    null
  }

  companion object {
    private const val PICK_IMPORT = 7401
    private const val PICK_EXPORT = 7402
    private const val PICK_ATTACH = 7403
    private const val PICK_SAVE = 7404
  }
}
