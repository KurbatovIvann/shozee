import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly variant?: ButtonVariant;
  readonly size?: "default" | "lg";
  readonly fullWidth?: boolean;
  readonly icon?: ReactNode;
}) {
  const variant = props.variant ?? "primary";
  const size = props.size ?? "default";
  const disabled = props.disabled === true || props.loading === true;
  const { theme } = useUnistyles();
  const indicatorByVariant = {
    primary: theme.colors.activityIndicator.onPrimary,
    danger: theme.colors.destructive,
    secondary: theme.colors.activityIndicator.onBackground,
    ghost: theme.colors.activityIndicator.onBackground,
  } as const;
  const indicatorColor = indicatorByVariant[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        SIZE_CHROME[size],
        props.fullWidth === true ? styles.fullWidth : null,
        VARIANT_CHROME[variant],
        variant === "danger" && pressed && !disabled
          ? styles.dangerPressed
          : null,
        disabled
          ? variant === "primary"
            ? styles.disabledPrimary
            : styles.disabled
          : null,
        pressed && !disabled && variant !== "danger" ? styles.pressed : null,
      ]}
    >
      {({ pressed }) =>
        props.loading === true ? (
          <ActivityIndicator color={indicatorColor} />
        ) : (
          <View style={styles.content}>
            {props.icon}
            <Text style={buttonLabelStyle(variant, pressed && !disabled)}>
              {props.label}
            </Text>
          </View>
        )
      }
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    minHeight: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
  },
  buttonLg: {
    minHeight: theme.hitTarget.lg,
  },
  fullWidth: {
    width: "100%",
    alignSelf: "stretch",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
  },
  primary: {
    backgroundColor: theme.colors.primary,
  },
  secondary: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  danger: {
    backgroundColor: theme.colors.destructiveSoft,
  },
  dangerPressed: {
    backgroundColor: theme.colors.destructive,
  },
  disabled: {
    opacity: 0.5,
  },
  disabledPrimary: {
    opacity: theme.disabledOpacity,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
  label: {
    color: theme.colors.primaryForeground,
    fontSize: theme.typography.md.fontSize,
    lineHeight: theme.typography.md.lineHeight,
    fontWeight: "600",
  },
  secondaryLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography.md.fontSize,
    lineHeight: theme.typography.md.lineHeight,
    fontWeight: "600",
  },
  ghostLabel: {
    color: theme.colors.primary,
    fontSize: theme.typography.md.fontSize,
    lineHeight: theme.typography.md.lineHeight,
    fontWeight: "600",
  },
  dangerLabel: {
    color: theme.colors.destructive,
    fontSize: theme.typography.md.fontSize,
    lineHeight: theme.typography.md.lineHeight,
    fontWeight: "600",
  },
  dangerPressedLabel: {
    color: theme.colors.destructiveForeground,
    fontSize: theme.typography.md.fontSize,
    lineHeight: theme.typography.md.lineHeight,
    fontWeight: "600",
  },
}));

const VARIANT_CHROME = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
} as const;

const VARIANT_LABEL = {
  primary: styles.label,
  secondary: styles.secondaryLabel,
  ghost: styles.ghostLabel,
  danger: styles.dangerLabel,
} as const;

const SIZE_CHROME = {
  default: null,
  lg: styles.buttonLg,
} as const;

function buttonLabelStyle(variant: ButtonVariant, dangerPressed: boolean) {
  if (variant === "danger" && dangerPressed) {
    return styles.dangerPressedLabel;
  }
  return VARIANT_LABEL[variant];
}
