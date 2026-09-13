interface Window {
  __GITHUB_CLIENT_ID__?: string | null;
}

declare module "@openhands/extensions/testing/automations/*.json" {
  // Bundled automation test fixtures (shipped under the package's
  // ``./testing/automations/*.json`` exports map). ResolveJsonModule never
  // sees them because the package provides no ``types`` condition for the
  // subpath; treat each fixture as arbitrary JSON.
  const value: Record<string, unknown>;
  export default value;
}

declare module "postcss-prefix-selector" {
  interface PrefixerOptions {
    prefix: string;
    transform?: (
      prefix: string,
      selector: string,
      prefixedSelector: string,
    ) => string;
  }

  export default function prefixer(
    options: PrefixerOptions,
  ): import("postcss").AcceptedPlugin;
}
