import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

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
export function useMotion() {
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => { changed = true; setMotion(!reduced); });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => { if (mounted && !changed) setMotion(!reduced); }, () => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return motion;
}
