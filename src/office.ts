import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, WidthType } from "docx";
import { PptxGenJS } from "./pi-runtime";

type Cell = string | number | boolean | null;
type Formula = { formula: string; result?: number };
type WordBlock = { kind: "heading" | "paragraph" | "bullet"; text: string; level?: number } | { kind: "table"; rows: string[][] };
export type Slide = { title: string; bullets: string[]; notes?: string; table?: string[][] };
export type Sheet = { name: string; rows: (Cell | Formula)[][]; header?: boolean };
export type OfficeData = { title: string; paragraphs?: string[]; blocks?: WordBlock[]; sheets?: Sheet[]; slides?: Slide[] };
export type OfficeEdits = { replacements?: { oldText: string; newText: string }[]; cells?: { sheet?: string; cell: string; value: Cell | Formula }[] };
export type OfficeSection = { title: string; lines: string[]; rows?: string[][] };
export type OfficeKind = "docx" | "xlsx" | "pptx";
type OfficeWindow = { section?: string; offset?: number; limit?: number; firstColumn?: number; columns?: number; formulas?: boolean };

export function officeKind(path: string): OfficeKind | undefined {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return extension;
}

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const packageNs = "http://schemas.openxmlformats.org/package/2006";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const sheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const MIME = "application/vnd.openxmlformats-officedocument";
const maxXml = 12 * 1024 * 1024;

function parseXml(value: Uint8Array, name: string) {
  const source = strFromU8(value);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("不支持含实体声明的 Office 文件。");
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  if (!parsed.documentElement) throw new Error("Office XML 无效：" + name);
  return parsed;
}

function officeTargets(parts: Record<string, Uint8Array>, directory: string, base: string, selector: string) {
  const root = `${directory}/${base}.xml`;
  const rels = `${directory}/_rels/${base}.xml.rels`;
  if (!parts[root] || !parts[rels]) return [];
  const relations = new Map(Array.from(parseXml(parts[rels], rels).getElementsByTagNameNS("*", "Relationship")).flatMap((relation) => {
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    if (!id || !target || relation.getAttribute("TargetMode") === "External") return [];
    const path = target.startsWith("/") ? target.slice(1) : `${directory}/${target}`;
    return !path.split("/").includes("..") && parts[path] ? [[id, path] as const] : [];
  }));
  return Array.from(parseXml(parts[root], root).getElementsByTagNameNS("*", selector)).flatMap((element) => {
    const id = element.getAttributeNS(relNs, "id") ?? element.getAttribute("r:id") ?? "";
    const path = relations.get(id);
    return path ? [{ path, name: element.getAttribute("name") ?? "" }] : [];
  });
}

function cleanXml(value: string) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ""); }

function escapeXml(value: string) {
  return cleanXml(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function textElement(tag: string, value: string) {
  return `<${tag} xml:space="preserve">${escapeXml(value)}</${tag}>`;
}

function relationships(items: { type: string; target: string }[]) {
  return xml + `<Relationships xmlns="${packageNs}/relationships">` + items.map(({ type, target }, index) =>
    `<Relationship Id="rId${index + 1}" Type="${relNs}/${type}" Target="${target}"/>`).join("") + "</Relationships>";
}

function pack(main: string, types: Record<string, string>, entries: Record<string, string>) {
  const contentTypes = xml + `<Types xmlns="${packageNs}/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + Object.entries(types).map(([path, type]) => `<Override PartName="/${path}" ContentType="${MIME}.${type}+xml"/>`).join("") + "</Types>";
  return zipSync(Object.fromEntries(Object.entries({
    ...entries, "[Content_Types].xml": contentTypes, "_rels/.rels": relationships([{ type: "officeDocument", target: main }]),
  }).map(([path, value]) => [path, strToU8(value)])), { level: 6 });
}

async function wordDocument(title: string, blocks: WordBlock[]) {
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const children = blocks.map((block) => {
    if (block.kind === "table") {
      if (!block.rows.length || block.rows.length > 200 || block.rows.some((row) => !row.length || row.length > 16)) throw new Error("Word 表格最多 200 行、16 列。");
      const width = Math.max(...block.rows.map((row) => row.length));
      return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({
        tableHeader: index === 0,
        children: Array.from({ length: width }, (_empty, column) => new TableCell({
          children: [new Paragraph(cleanXml(row[column] ?? ""))],
        })),
      })) });
    }
    const text = cleanXml(block.text);
    if (block.kind === "heading") return new Paragraph({ text, heading: headings[(block.level ?? 1) - 1] ?? HeadingLevel.HEADING_1 });
    if (block.kind === "bullet") return new Paragraph({ text, bullet: { level: 0 } });
    return new Paragraph(text);
  });
  const document = new Document({ title, creator: "Lyra", sections: [{ children: [new Paragraph({ text: cleanXml(title), heading: HeadingLevel.TITLE }), ...children] }] });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}

function excelFormula(value: Formula) {
  const formula = value.formula.trim().replace(/^=/, "");
  if (!formula || formula.length > 8192 || /[\[\]\u0000-\u001f]|\b(?:WEBSERVICE|RTD|HYPERLINK)\s*\(|\|[^!\r\n]*!/i.test(formula)) throw new Error("请输入有效的工作簿内部公式（不支持外部连接公式）。");
  if (value.result !== undefined && !Number.isFinite(value.result)) throw new Error("公式缓存结果必须是有限数字。");
  return formula;
}

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function workbook(sheets: Sheet[]) {
  const names = new Set<string>();
  let count = 0;
  const book = "xl/workbook.xml";
  const types: Record<string, string> = { [book]: "spreadsheetml.sheet.main" };
  const entries: Record<string, string> = {};
  const parts = sheets.map(({ name, rows, header }, index) => {
    if (!name.trim() || name.length > 31 || /[\\/\[\]:?*]/.test(name) || /^'|'$/.test(name) || names.has(name.toLowerCase())) {
      throw new Error("工作表名称必须唯一，长度不超过 31 个字符，并且不能包含 Excel 的保留字符。");
    }
    names.add(name.toLowerCase());
    const target = `worksheets/sheet${index + 1}.xml`;
    types[`xl/${target}`] = "spreadsheetml.worksheet";
    const lastColumn = columnName(rows.reduce((width, row) => Math.max(width, row.length), 1) - 1);
    const range = `A1:${lastColumn}${Math.max(1, rows.length)}`;
    entries[`xl/${target}`] = xml + `<worksheet xmlns="${sheetNs}"><dimension ref="${range}"/>`
      + (header && rows.length ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "")
      + "<sheetData>"
      + rows.map((row, y) => {
        count += row.length;
        if (count > 30_000 || row.length > 128) throw new Error("工作簿限 30,000 个单元格、每行 128 列。");
        return `<row r="${y + 1}">` + row.map((value, x) => {
          const id = `${columnName(x)}${y + 1}`;
          if (value === null) return "";
          if (typeof value === "object") return `<c r="${id}"><f>${escapeXml(excelFormula(value))}</f>${value.result === undefined ? "" : `<v>${value.result}</v>`}</c>`;
          if (typeof value === "number" && Number.isFinite(value)) return `<c r="${id}"><v>${value}</v></c>`;
          if (typeof value === "boolean") return `<c r="${id}" t="b"><v>${Number(value)}</v></c>`;
          return `<c r="${id}" t="inlineStr"><is>${textElement("t", String(value).slice(0, 32767))}</is></c>`;
        }).join("") + "</row>";
      }).join("") + "</sheetData>" + (header && rows.length ? `<autoFilter ref="${range}"/>` : "") + "</worksheet>";
    return { name, target, type: "worksheet" };
  });
  entries[book] = xml + `<workbook xmlns="${sheetNs}" xmlns:r="${relNs}"><sheets>`
    + parts.map(({ name }, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>';
  entries["xl/_rels/workbook.xml.rels"] = relationships(parts);
  return pack(book, types, entries);
}

async function presentation(title: string, slides: Slide[]) {
  const ppt = new PptxGenJS();
  ppt.layout = "LAYOUT_WIDE";
  ppt.title = title;
  ppt.author = "Lyra";
  for (const [index, content] of slides.entries()) {
    const slide = ppt.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(content.title || title, { x: 0.8, y: 0.64, w: 11.65, h: 0.88, margin: 0, fontSize: 32, bold: true, color: "101216", fit: "shrink" });
    slide.addShape(ppt.ShapeType.line, { x: 0.8, y: 1.66, w: 11.65, h: 0, line: { color: "DBDEE4", width: 1 } });
    if (content.table && (!content.table.length || content.table.length > 8 || content.table.some((row) => !row.length || row.length > 6))) throw new Error("单张幻灯片表格最多 8 行、6 列。");
    const lineHeight = Math.min(0.73, (content.table ? 1.7 : 4.54) / Math.max(1, content.bullets.length));
    content.bullets.forEach((line, row) => slide.addText(line, { x: 0.98, y: 1.99 + row * lineHeight, w: 11.25,
      h: lineHeight - 0.04, margin: 0, fontSize: content.table ? 15 : content.bullets.length > 8 ? 17 : 22, bullet: { indent: 16 }, color: "303641", fit: "shrink", valign: "middle" }));
    if (content.table) slide.addTable(content.table.map((row) => row.map((text) => ({ text: cleanXml(text) }))), { x: 0.98, y: content.bullets.length ? 3.78 : 1.99, w: 11.25,
      fontSize: 13, rowH: 0.33, margin: 0.05, border: { color: "DBDEE4", pt: 0.7 }, autoPage: false });
    slide.addText(`${index + 1} / ${slides.length}`, { x: 10.8, y: 6.87, w: 1.65, h: 0.28, margin: 0, align: "right", fontSize: 10, color: "697281" });
    if (content.notes) slide.addNotes(content.notes);
  }
  const buffer = await ppt.write({ outputType: "arraybuffer", compression: true });
  if (!(buffer instanceof ArrayBuffer)) throw new Error("PowerPoint 生成器未返回文件字节。");
  return new Uint8Array(buffer);
}

export async function createOffice(kind: OfficeKind, data: OfficeData) {
  const title = data.title.trim();
  if (!title) throw new Error("文档标题不能为空。");
  if (kind === "docx") {
    const blocks = data.blocks ?? data.paragraphs?.map((text): WordBlock => ({ kind: "paragraph", text }));
    if (blocks?.length && blocks.length <= 4000) return wordDocument(title, blocks);
  }
  if (kind === "xlsx" && data.sheets?.length && data.sheets.length <= 24) return workbook(data.sheets);
  if (kind === "pptx" && data.slides?.length && data.slides.length <= 60 && data.slides.every((slide) => slide.bullets.length <= 14)) {
    return presentation(title, data.slides);
  }
  throw new Error("内容与文件格式不匹配，或超出上限（4000 段、24 张工作表、60 张幻灯片及每页 14 条）。");
}

export function readOffice(kind: OfficeKind, bytes: Uint8Array, sectionLimit = 20, window: OfficeWindow = {}): OfficeSection[] {
  let total = 0;
  let count = 0;
  const pattern = kind === "docx" ? /^word\/document\.xml$/ : kind === "pptx" ? /^ppt\/(slides\/[^/]+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/
    : /^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/;
  const parts = unzipSync(bytes, { filter: ({ name, originalSize }) => {
    if (!pattern.test(name)) return false;
    total += originalSize;
    if (total > maxXml || ++count > 128) throw new Error("Office 文件的可预览内容过大。");
    return true;
  } });
  function parse(name: string) {
    const value = parts[name];
    if (!value) throw new Error("Office 文件缺少 " + name);
    return parseXml(value, name);
  }
  const titleOrder = (left: string, right: string) => Number(/\d+(?=\.xml$)/.exec(left)?.[0]) - Number(/\d+(?=\.xml$)/.exec(right)?.[0]);
  const start = Math.max(0, (window.offset ?? 1) - 1);
  if (kind === "docx") {
    const body = parse("word/document.xml");
    const lines = Array.from(body.getElementsByTagNameNS("*", "p")).slice(start, start + (window.limit ?? 240)).map((paragraph) => (
      Array.from(paragraph.getElementsByTagNameNS("*", "t")).map((item) => item.textContent ?? "").join("")
    )).filter(Boolean);
    return [{ title: "文档", lines }];
  }
  if (kind === "pptx") {
    const ordered = officeTargets(parts, "ppt", "presentation", "sldId");
    const slides = ordered.length ? ordered.map(({ path }) => path) : Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(titleOrder);
    if (!slides.length) throw new Error("没有找到幻灯片。");
    const selected = slides.map((path, index) => ({ path, title: `第 ${index + 1} 页`, number: String(index + 1) }))
      .filter(({ title, number }) => !window.section || [title, number].includes(window.section)).slice(0, sectionLimit);
    if (!selected.length) throw new Error("找不到幻灯片：" + window.section);
    return selected.map(({ path, title }) => {
      const lines = Array.from(parse(path).getElementsByTagNameNS("*", "t")).slice(start, start + (window.limit ?? 60)).map((item) => item.textContent ?? "").filter(Boolean);
      return { title, lines };
    });
  }
  const shared = parts["xl/sharedStrings.xml"] ? Array.from(parse("xl/sharedStrings.xml").getElementsByTagNameNS("*", "si")) : [];
  const ordered = officeTargets(parts, "xl", "workbook", "sheet");
  if (!ordered.length) throw new Error("没有找到工作表。");
  const selected = ordered.filter(({ name }) => !window.section || name === window.section).slice(0, sectionLimit);
  if (!selected.length) throw new Error("找不到工作表：" + window.section);
  const firstColumn = Math.max(0, (window.firstColumn ?? 1) - 1);
  const columnCount = window.columns ?? 30;
  return selected.map(({ path, name }, index) => {
    const limit = window.limit ?? 100;
    const sheetRows = Array.from(parse(path).getElementsByTagNameNS("*", "row"));
    const range = window.offset === undefined ? sheetRows.slice(0, limit) : sheetRows.filter((row) => {
      const rowNumber = Number(row.getAttribute("r"));
      return rowNumber > start && rowNumber <= start + limit;
    }).slice(0, limit);
    const rowNumbers: number[] = [];
    const rows = range.map((row) => {
      rowNumbers.push(Number(row.getAttribute("r")));
      const cells: string[] = [];
      for (const cell of Array.from(row.getElementsByTagNameNS("*", "c"))) {
        const column = /^[A-Z]+/.exec(cell.getAttribute("r") ?? "")?.[0];
        const absolute = column ? [...column].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1 : cells.length;
        const position = absolute - firstColumn;
        if (position < 0 || position >= columnCount) continue;
        const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
        const type = cell.getAttribute("t");
        const formula = cell.getElementsByTagNameNS("*", "f")[0]?.textContent;
        const display = (type === "s" ? shared[Number(value)]?.textContent : type === "inlineStr"
          ? cell.getElementsByTagNameNS("*", "is")[0]?.textContent : type === "b" ? (value === "1" ? "TRUE" : "FALSE") : value) ?? "";
        cells[position] = formula && (window.formulas || !display) ? `=${formula}${display ? ` → ${display}` : ""}` : display;
      }
      return Array.from(cells, (value) => value ?? "");
    });
    return { title: name || `工作表 ${index + 1}`, lines: rows.map((row, i) => (window.offset !== undefined ? `${rowNumbers[i]}\t` : "") + row.join("\t")), rows };
  });
}

export function editOffice(kind: OfficeKind, bytes: Uint8Array, changes: OfficeEdits) {
  let size = 0;
  let count = 0;
  const parts = unzipSync(bytes, { filter: ({ name, originalSize }) => {
    if (name.startsWith("_xmlsignatures/")) throw new Error("此文件带有数字签名，编辑会使签名失效。");
    size += originalSize;
    if (size > 48 * 1024 * 1024 || ++count > 2000) throw new Error("此 Office 文件超过原地编辑的大小限制。");
    return true;
  } });
  const serialize = new XMLSerializer();
  const changed = new Map<string, ReturnType<typeof parseXml>>();
  function document(path: string) {
    if (!parts[path]) throw new Error("Office 文件缺少 " + path);
    const parsed = changed.get(path) ?? parseXml(parts[path], path);
    changed.set(path, parsed);
    return parsed;
  }
  let edits = 0;

  if (kind === "xlsx") {
    if (!changes.cells?.length) throw new Error("请提供要修改的 Excel 单元格。");
    const sheets = officeTargets(parts, "xl", "workbook", "sheet");
    const col = (ref: string) => ([...(ref.match(/^[A-Z]+/)?.[0] ?? "")]).reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
    for (const change of changes.cells) {
      const sheet = change.sheet ? sheets.find(({ name }) => name === change.sheet) : sheets[0];
      if (!sheet) throw new Error("找不到工作表：" + (change.sheet ?? "首张表"));
      const target = change.cell.toUpperCase();
      const rowIndex = Number(target.match(/\d+$/)?.[0]);
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(target) || col(target) > 16384 || rowIndex > 1048576) throw new Error("无效的 Excel 单元格：" + target);
      const doc = document(sheet.path);
      const data = doc.getElementsByTagNameNS("*", "sheetData")[0];
      if (!data) throw new Error("工作表缺少 sheetData。");
      const make = (tag: string) => doc.createElementNS(data.namespaceURI || sheetNs, data.prefix ? `${data.prefix}:${tag}` : tag);
      const rows = Array.from(data.getElementsByTagNameNS("*", "row"));
      let row = rows.find((item) => Number(item.getAttribute("r")) === rowIndex);
      if (!row) {
        row = make("row"); row.setAttribute("r", String(rowIndex));
        data.insertBefore(row, rows.find((item) => Number(item.getAttribute("r")) > rowIndex) ?? null);
      }
      const children = Array.from(row.getElementsByTagNameNS("*", "c"));
      let cell = children.find((item) => item.getAttribute("r") === target);
      if (!cell) {
        cell = make("c"); cell.setAttribute("r", target);
        row.insertBefore(cell, children.find((item) => col(item.getAttribute("r") ?? "") > col(target)) ?? null);
      }
      const formulaNode = cell.getElementsByTagNameNS("*", "f")[0];
      if (formulaNode && /^(shared|array|dataTable)$/.test(formulaNode.getAttribute("t") ?? "") && formulaNode.getAttribute("ref")) {
        throw new Error("该单元格是共享、数组或数据表公式的起始位置，需要在 Excel 中修改其公式范围。");
      }
      const dimension = doc.getElementsByTagNameNS("*", "dimension")[0];
      const range = dimension?.getAttribute("ref")?.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if (dimension && range) {
        const first = columnName(Math.min(col(range[1]), col(target)) - 1) + Math.min(Number(range[2]), rowIndex);
        const last = columnName(Math.max(col(range[3] ?? range[1]), col(target)) - 1) + Math.max(Number(range[4] ?? range[2]), rowIndex);
        dimension.setAttribute("ref", first === last ? first : `${first}:${last}`);
      }
      for (const tag of ["f", "v", "is"]) Array.from(cell.getElementsByTagNameNS("*", tag)).forEach((item) => item.parentNode?.removeChild(item));
      cell.removeAttribute("t");
      if (typeof change.value === "string") {
        cell.setAttribute("t", "inlineStr");
        const inline = make("is"); const text = make("t");
        text.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        text.textContent = cleanXml(change.value.slice(0, 32767)); inline.appendChild(text); cell.appendChild(inline);
      } else if (change.value && typeof change.value === "object") {
        const expression = make("f");
        expression.textContent = excelFormula(change.value);
        cell.appendChild(expression);
        if (change.value.result !== undefined) {
          const value = make("v");
          value.textContent = String(change.value.result);
          cell.appendChild(value);
        }
      } else if (change.value !== null) {
        const value = make("v");
        if (typeof change.value === "boolean") cell.setAttribute("t", "b");
        value.textContent = String(typeof change.value === "boolean" ? Number(change.value) : change.value);
        cell.appendChild(value);
      }
      edits++;
    }
  } else {
    if (!changes.replacements?.length) throw new Error("请提供 Word 或 PowerPoint 的文字替换。");
    const files = kind === "docx" ? ["word/document.xml"] : officeTargets(parts, "ppt", "presentation", "sldId").map(({ path }) => path);
    const paragraphs = files.flatMap((path) => Array.from(document(path).getElementsByTagNameNS("*", "p")));
    for (const { oldText, newText } of changes.replacements) {
      if (!oldText) throw new Error("旧文本不能为空。");
      const matches = paragraphs.flatMap((paragraph) => {
        const runs = Array.from(paragraph.getElementsByTagNameNS("*", "t"));
        const text = runs.map((node) => node.textContent ?? "").join("");
        const start = text.indexOf(oldText);
        return start < 0 ? [] : [{ runs, start, duplicate: text.indexOf(oldText, start + 1) >= 0 }];
      });
      if (matches.length !== 1 || matches[0].duplicate) throw new Error("文字没有唯一匹配，请提供更完整的上下文。");
      const { runs, start } = matches[0];
      let cursor = 0;
      for (const node of runs) {
        const original = node.textContent ?? "";
        const begin = cursor;
        cursor += original.length;
        if (cursor <= start || begin >= start + oldText.length) continue;
        node.textContent = original.slice(0, Math.max(0, start - begin)) + (begin <= start ? cleanXml(newText) : "") + original.slice(Math.max(0, start + oldText.length - begin));
        node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      }
      edits++;
    }
  }
  for (const [path, doc] of changed) parts[path] = strToU8(serialize.serializeToString(doc));
  return { bytes: zipSync(parts, { level: 6 }), edits };
}
