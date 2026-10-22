// Runs once when the server starts. The checks use Node.js-only modules, so
// they are loaded only in the Node.js runtime.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node.js');
  }
}
