package com.lyramobile

import android.app.Activity
import android.content.Intent
import android.util.AtomicFile
import java.io.File
import android.util.Base64
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
  private data class Picker(val type: Int, val workspace: String, val promise: Promise)

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

  private fun pick(type: Int, workspace: String, intent: Intent, promise: Promise) {
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
      picker = Picker(type, workspace, promise)
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
  }
}
