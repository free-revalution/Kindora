/**
 * Welcome screen — entry point when no agent exists on this device.
 *
 * 开发手册.md § 6.1.
 */

interface WelcomeProps {
  onCreate: () => void;
}

export function Welcome({ onCreate }: WelcomeProps) {
  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-6xl font-semibold tracking-tight">Kindora</h1>
      <p className="text-kindora-700 dark:text-kindora-200 mt-8 text-xl leading-relaxed">
        Your AI finds the connection.
        <br />
        You make the friendship.
      </p>

      <p className="text-kindora-600 dark:text-kindora-300 mt-10 max-w-md text-sm leading-relaxed">
        Create a personal AI social agent that understands you, helps you find genuinely compatible
        people, and then gets out of the way.
      </p>

      <button type="button" className="kindora-button mt-12 px-8 py-3 text-base" onClick={onCreate}>
        Create My Agent
      </button>

      <p className="text-kindora-500 dark:text-kindora-400 mt-8 text-xs">
        Local-first · Open source · MIT
      </p>
    </main>
  );
}
