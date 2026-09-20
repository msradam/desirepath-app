import { defineConfig, devices } from '@playwright/test';

/**
 * WebGPU + Cross-Origin-Isolation in Playwright.
 *
 * Headless WebGPU on Apple Silicon: we run in **headed** mode by default
 * (`headless: false`) because:
 *   - Apple Metal isn't accessible from headless Chromium reliably
 *   - SwiftShader software fallback technically works but Granite 4.0 1B
 *     inference under SwiftShader is ~100× slower than Metal. Minutes
 *     per query instead of seconds
 *
 * Set ARIADNE_HEADLESS=1 to force headless (uses --enable-unsafe-swiftshader).
 *
 * The Vite dev server provides COEP/COOP headers (see vite.config.ts), which
 * is what makes self.crossOriginIsolated true. Required for SharedArrayBuffer
 * which WebLLM needs.
 */
const HEADLESS = process.env.ARIADNE_HEADLESS === '1';

/**
 * Where the tests point.
 *
 * The dev server cannot load the model: `optimizeDeps.exclude` on
 * @mlc-ai/web-llm means Vite serves the package unbundled, and the TVM runtime
 * import the model library needs is not wired up, so WebAssembly.instantiate
 * fails with "function import requires a callable". The production build is
 * fine. Set ARIADNE_BASE_URL to a `npm run preview` server for anything that
 * needs the model; leave it unset for the surfaces that do not.
 */
const BASE_URL = process.env.ARIADNE_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests/e2e',
  // Granite model load + each LLM round-trip eats real seconds.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,        // serialise. Only one Chromium can hold the GPU
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          headless: HEADLESS,
          args: [
            '--enable-features=Vulkan,SharedArrayBuffer,WebGPUDeveloperFeatures',
            '--enable-webgpu-developer-features',
            // SwiftShader only when headless. Passing it in headed mode forces
            // software rendering on a machine that has Metal, and the model
            // then takes so long to load that the run looks hung rather than
            // slow: the browser sits at zero percent CPU with no network
            // activity while the GPU path crawls.
            ...(HEADLESS ? ['--use-vulkan=swiftshader', '--enable-unsafe-swiftshader'] : []),
          ],
          // Ignore HTTPS errors so we don't fight self-signed certs in CI.
          ignoreHTTPSErrors: true,
        },
      },
    },
  ],

  // Only start a dev server when the tests are not pointed somewhere else.
  ...(process.env.ARIADNE_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
