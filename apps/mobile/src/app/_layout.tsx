import "../theme/unistyles";
import "../i18n/install-locale";

import { useEffect } from "react";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useUnistyles } from "react-native-unistyles";

import { ApiProvider } from "../api/api-provider";
import { QueryRuntimeProvider } from "../api/query-provider";
import { SessionProvider } from "../auth/session-provider";
import { ConfirmationCardProvider } from "../components/ui/confirmation-card-host";
import { confirmationCardEn, confirmationCardUk } from "../i18n/copy";
import { detectLocale } from "../i18n/locale";

export default function RootLayout() {
  const { theme, rt } = useUnistyles();
  const confirmationCardCopy =
    detectLocale() === "uk" ? confirmationCardUk : confirmationCardEn;

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.background);
  }, [theme.colors.background]);

  return (
    <SafeAreaProvider>
      <KeyboardProvider
        statusBarTranslucent
        navigationBarTranslucent
        preserveEdgeToEdge
      >
        <SessionProvider>
          <ApiProvider>
            <QueryRuntimeProvider>
              <ConfirmationCardProvider copy={confirmationCardCopy}>
                <StatusBar style={rt.themeName === "dark" ? "light" : "dark"} />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: theme.colors.background },
                  }}
                />
              </ConfirmationCardProvider>
            </QueryRuntimeProvider>
          </ApiProvider>
        </SessionProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
