import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "lucide-react-native";
import { colors } from "./theme";

export function FileIcon({ name, mime = "", size = 17 }: { name: string; mime?: string; size?: number }) {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const Icon = /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/.test(ext) || /spreadsheet|ms-excel|text\/csv/.test(mime) ? FileSpreadsheet
    : /^(pptx?|pptm|odp|key)$/.test(ext) || /presentation|ms-powerpoint/.test(mime) ? Presentation
    : /^(png|jpe?g|webp|gif|bmp|heif|heic|avif|tiff?|ico|svg)$/.test(ext) || mime.startsWith("image/") ? FileImage
    : /^(zip|rar|7z|tgz|tar|gz|xz|bz2|apk)$/.test(ext) || /zip|compressed|archive/.test(mime) ? FileArchive
    : /^(mp3|m4a|wav|ogg|flac|aac|opus)$/.test(ext) || mime.startsWith("audio/") ? FileAudio
    : /^(mp4|mov|webm|mkv|avi|m4v)$/.test(ext) || mime.startsWith("video/") ? FileVideo
    : /^(tsx?|jsx?|json|ya?ml|toml|xml|html?|css|py|rb|go|rs|java|kt|swift|sql|sh|ps1)$/.test(ext) ? FileCode
    : /^(docx?|odt|rtf|txt|pdf|mdx?|pages|log)$/.test(ext) || /wordprocessing|msword|pdf|text\//.test(mime) ? FileText : File;
  return <Icon size={size} color={colors.secondary} />;
}
