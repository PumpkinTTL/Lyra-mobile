import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "lucide-react-native";
import { colors } from "./theme";

export function FileIcon({ name, mime = "", size = 17 }: { name: string; mime?: string; size?: number }) {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const [Icon, color] = /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/.test(ext) || /spreadsheet|ms-excel|text\/csv/.test(mime) ? [FileSpreadsheet, "#26734e"] as const
    : /^(pptx?|pptm|odp|key)$/.test(ext) || /presentation|ms-powerpoint/.test(mime) ? [Presentation, "#bd5128"] as const
    : ext === "pdf" || mime === "application/pdf" ? [FileText, "#bf474b"] as const
    : /^(docx?|odt|rtf|pages)$/.test(ext) || /wordprocessing|msword/.test(mime) ? [FileText, "#315ea3"] as const
    : /^(png|jpe?g|webp|gif|bmp|heif|heic|avif|tiff?|ico|svg)$/.test(ext) || mime.startsWith("image/") ? [FileImage, "#7c55a8"] as const
    : /^(zip|rar|7z|tgz|tar|gz|xz|bz2|apk)$/.test(ext) || /zip|compressed|archive/.test(mime) ? [FileArchive, "#9a6c28"] as const
    : /^(mp3|m4a|wav|ogg|flac|aac|opus)$/.test(ext) || mime.startsWith("audio/") ? [FileAudio, "#9a477d"] as const
    : /^(mp4|mov|webm|mkv|avi|m4v)$/.test(ext) || mime.startsWith("video/") ? [FileVideo, "#5966a1"] as const
    : /^(tsx?|jsx?|json|ya?ml|toml|xml|html?|css|py|rb|go|rs|java|kt|swift|sql|sh|ps1)$/.test(ext) ? [FileCode, "#247780"] as const
    : /^(txt|mdx?|log)$/.test(ext) || mime.startsWith("text/") ? [FileText, colors.secondary] as const
    : [File, colors.secondary] as const;
  return <Icon size={size} color={color} />;
}
