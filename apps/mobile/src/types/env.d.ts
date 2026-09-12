/**
 * Expo inlines `EXPO_PUBLIC_*` at bundle time. This ambient keeps the
 * client tsconfig (`types: []`) from needing `@types/node`.
 */
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_API_URL?: string;
    /** Set by EAS Build; unset for local `expo run` / prebuild. */
    readonly EAS_BUILD_PROFILE?: string;
  };
};

/**
 * Vitest handshake tests (SHO-200) read the live hook source via Node.
 * Production mobile code does not import `node:fs`.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

/**
 * Vitest debounce-hook tests (SHO-220) mount with react-dom createRoot +
 * act. react-dom 19 does not ship types; do not add `@types/react-dom`.
 */
declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export type Root = {
    render: (children: ReactNode) => void;
    unmount: () => void;
  };

  export function createRoot(container: { readonly nodeType: number }): Root;
}

/** Metro inlines this to `true` in the Expo dev client and `false` in release. */
declare const __DEV__: boolean;

/**
 * Local SVG assets (Shozik poses). Metro treats `.svg` as an image asset;
 * `require` / default import resolves to a numeric module id for expo-image.
 */
declare module "*.svg" {
  const src: number;
  export default src;
}
