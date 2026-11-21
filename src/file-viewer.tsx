import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import WebView from "react-native-webview";
import { officeViewerScript } from "./pi-runtime";
import { readOffice } from "./office";
import { colors } from "./theme";

type WebContent = { html: string; script?: string };
const origin = "https://lyra-preview.invalid/";
const viewerPolicy = "default-src 'none'; script-src 'nonce-lyra-preview'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; base-uri 'none'; form-action 'none'";
const css = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #252525; font: 15px system-ui, sans-serif; background: #fff; }
  body > main { min-height: 100vh; }
  main.media { display: grid; place-items: center; background: #f5f5f5; }
  main.media img, main.pptx canvas { display: block; width: auto; max-width: 100%; height: auto; }
  main.pptx { display: grid; place-items: center; background: #f5f5f5; }
  main.docx .document-page-wrapper { padding: 0; gap: 8px; background: #f5f5f5; }
  main.docx .document-page-wrapper > section.document-page { margin-bottom: 8px; }
  .sheet table { border-collapse: collapse; min-width: 100%; font-size: 13px; }
  .sheet :is(td, th) { min-width: 104px; max-width: 250px; padding: 6px 9px; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #e3e4e3; text-align: left; }
  .sheet th { font-weight: 500; color: #3c5044; background: #eff4f0; position: sticky; top: 0; z-index: 1; }
  .sheet tr > :first-child { min-width: 42px; width: 42px; text-align: right; position: sticky; left: 0; background: #eff4f0; color: #3c5044; }
  .sheet tr:nth-child(even) td:not(:first-child) { background: #f9faf9; }
`;

function columnName(index: number): string {
  let result = "";
  for (let column = index + 1; column > 0; column = Math.floor((column - 1) / 26)) {
    result = String.fromCharCode(65 + (column - 1) % 26) + result;
  }
  return result;
}

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tableContent(rows: string[][], rowNumbers: number[], firstColumn: number): WebContent {
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 1);
  const headings = Array.from({ length: width }, (_, column) => `<th scope="col">${columnName(firstColumn + column)}</th>`).join("");
  const body = rows.map((row, index) => `<tr><td>${rowNumbers[index] ?? index + 1}</td>${Array.from({ length: width }, (_, column) => (
    `<td>${escapeText(row[column] ?? "")}</td>`
  )).join("")}</tr>`).join("");
  return { html: `<main class="sheet"><table><thead><tr><th scope="col">行</th>${headings}</tr></thead><tbody>${body}</tbody></table></main>` };
}

export function mediaContent(mime: string, base64: string): WebContent {
  return { html: `<main class="media"><img alt="文件内容" src="data:${mime};base64,${base64}"></main>` };
}

export function officeContent(kind: "docx" | "pptx", base64: string): WebContent {
  return { html: `<main class="${kind}" id="reader"></main>`,
    script: `window.lyraPreviewInput=${JSON.stringify([kind, base64])};${officeViewerScript.replace(/<\/script/gi, "<\\/script")}` };
}

export function PageBar({ page, count, disabled, onChange }: { page: number; count: number; disabled?: boolean; onChange(page: number): void }) {
  function button(label: string, target: number, Icon: typeof ChevronLeft) {
    const unavailable = disabled || target < 0 || target >= count;
    return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={unavailable} style={[styles.pageButton, unavailable && styles.disabled]}
      onPress={() => onChange(target)}><Icon size={20} color={colors.text} /></Pressable>;
  }
  return <View style={styles.pager}>
    {button("上一页", page - 1, ChevronLeft)}
    <Text style={styles.hint}>{page + 1} / {count}</Text>
    {button("下一页", page + 1, ChevronRight)}
  </View>;
}

export function FileViewer({ content }: { content: WebContent }) {
  const web = useRef<WebView<unknown>>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [slide, setSlide] = useState<{ index: number; count: number }>();
  const source = useMemo(() => ({ baseUrl: origin,
    html: `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="${viewerPolicy}"><style>${css}</style></head><body>${content.html}${content.script ? `<script nonce="lyra-preview">${content.script}</script>` : ""}</body></html>` }), [content]);
  const fail = () => { setLoading(false); setFailed(true); };

  useEffect(() => {
    if (!loading) return;
    const timeout = setTimeout(fail, 20_000);
    return () => clearTimeout(timeout);
  }, [loading]);

  if (failed) return <Text accessibilityRole="alert" style={styles.note}>文件无法在应用内显示。可以通过上方操作打开或分享原文件。</Text>;
  return <View style={styles.fill}>
    {slide && slide.count > 1 ? <PageBar page={slide.index} count={slide.count}
      onChange={(index) => web.current?.injectJavaScript(`window.lyraShowSlide(${index}); true;`)} /> : null}
    <WebView<unknown> ref={web} source={source} style={styles.fill}
      javaScriptEnabled={!!content.script} domStorageEnabled={false} thirdPartyCookiesEnabled={false} allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
      allowsLinkPreview={false} setBuiltInZoomControls setDisplayZoomControls={false}
      originWhitelist={["*"]} onShouldStartLoadWithRequest={({ url }) => url === "about:blank" || url === origin}
      onLoad={() => { if (!content.script) setLoading(false); }} onError={fail}
      onRenderProcessGone={fail} onContentProcessDidTerminate={fail}
      onMessage={content.script ? ({ nativeEvent: { data } }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === "slide" && Number.isInteger(event.index) && Number.isInteger(event.count)) {
            setSlide({ index: event.index, count: event.count });
          } else if (event.type === "failed") setFailed(true);
          else if (event.type !== "ready") return;
          setLoading(false);
        } catch { /* Ignore unrelated messages. */ }
      } : undefined} />
    {loading ? <View pointerEvents="none" style={styles.spinner}><ActivityIndicator color={colors.secondary} /></View> : null}
  </View>;
}

export function TextViewer({ text }: { text: string }) {
  return <ScrollView contentContainerStyle={styles.note}><Text selectable style={styles.code}>{text || "空文件"}</Text></ScrollView>;
}

export function SpreadsheetViewer({ source, sheets }: { source: Uint8Array; sheets: string[] }) {
  const [section, setSection] = useState(sheets[0]);
  const [page, setPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const limit = 80;
  const columns = 26;
  const sheet = useMemo(() => {
    try {
      const [data] = readOffice("xlsx", source, 1, { section, rowIndex: page * limit, limit, firstColumn: columnPage * columns + 1, columns });
      return { data, content: tableContent(data.rows ?? [], data.rowNumbers ?? [], columnPage * columns) };
    } catch { return undefined; }
  }, [source, section, page, columnPage]);
  const pageCount = Math.ceil((sheet?.data.rowCount ?? 0) / limit);
  const columnPageCount = Math.ceil((sheet?.data.columnCount ?? 0) / columns);
  return <View style={styles.fill}>
    {sheets.length > 1 ? <View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {sheets.map((name) => <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: section === name }}
        style={[styles.tab, section === name && styles.selectedTab]} onPress={() => { setSection(name); setPage(0); setColumnPage(0); }}>
        <Text style={styles.tabLabel} numberOfLines={1}>{name}</Text>
      </Pressable>)}
    </ScrollView></View> : null}
    {sheet ? <FileViewer key={`${section}:${page}:${columnPage}`} content={sheet.content} />
      : <Text accessibilityRole="alert" style={styles.note}>这个工作表无法显示。可以通过上方操作打开原文件。</Text>}
    {pageCount > 1 || columnPageCount > 1 ? <View style={styles.sheetPages}>
      {pageCount > 1 ? <View style={styles.sheetPager}><Text style={styles.hint}>行</Text><PageBar page={page} count={pageCount}
        onChange={(index) => { setPage(index); setColumnPage(0); }} /></View> : null}
      {columnPageCount > 1 ? <View style={styles.sheetPager}><Text style={styles.hint}>列</Text><PageBar page={columnPage} count={columnPageCount}
        onChange={setColumnPage} /></View> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pager: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 14 },
  pageButton: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
  disabled: { opacity: 0.28 },
  hint: { color: colors.secondary, fontSize: 13, fontVariant: ["tabular-nums"] },
  spinner: { ...StyleSheet.absoluteFill, justifyContent: "center", alignItems: "center" },
  note: { padding: 16, color: colors.secondary },
  code: { color: colors.text, fontFamily: "monospace", lineHeight: 20, fontSize: 14 },
  tabs: { gap: 8, paddingHorizontal: 12 },
  tab: { minHeight: 42, maxWidth: 180, justifyContent: "center", paddingHorizontal: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  selectedTab: { borderBottomColor: "#477459" },
  tabLabel: { color: colors.text, fontSize: 14 },
  sheetPages: { flexDirection: "row", justifyContent: "space-evenly", flexWrap: "wrap" },
  sheetPager: { flexDirection: "row", alignItems: "center", gap: 2 },
});
