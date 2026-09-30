import type { darkTheme } from "../../theme/dark";
import type { lightTheme } from "../../theme/light";

export type ChipTheme = typeof lightTheme | typeof darkTheme;

export type ChipCapsuleStyle = {
  flexShrink: number;
  minHeight: number;
  justifyContent: "center";
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  backgroundColor: string;
  paddingHorizontal: number;
};

export function chipCapsule(input: {
  readonly theme: ChipTheme;
  readonly paddingHorizontal: number;
  readonly shrink: boolean;
}): ChipCapsuleStyle {
  return {
    flexShrink: input.shrink ? 1 : 0,
    minHeight: input.theme.hitTarget.min,
    justifyContent: "center",
    borderRadius: input.theme.radii.full,
    borderWidth: 1,
    borderColor: input.theme.colors.border,
    backgroundColor: input.theme.colors.card,
    paddingHorizontal: input.paddingHorizontal,
  };
}

export function chipPressed(theme: ChipTheme): { opacity: number } {
  return { opacity: theme.pressedOpacity };
}
