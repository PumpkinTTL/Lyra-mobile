// sRGB equivalents of the assistant-ui React Native starter's light tokens.
const nativeTokens = {
  background: "#ffffff",
  foreground: "#09090b",
  card: "#ffffff",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  muted: "#f4f4f5",
  mutedForeground: "#71717b",
  border: "#e4e4e7",
  destructive: "#e7000b",
};

export const colors = {
  background: nativeTokens.background,
  surface: nativeTokens.card,
  raised: nativeTokens.muted,
  border: nativeTokens.border,
  text: nativeTokens.foreground,
  secondary: nativeTokens.mutedForeground,
  accent: nativeTokens.primary,
  accentInk: nativeTokens.primaryForeground,
  tint: nativeTokens.muted,
  tintBorder: nativeTokens.border,
  error: nativeTokens.destructive,
  overlay: "rgba(0, 0, 0, 0.35)",
};
