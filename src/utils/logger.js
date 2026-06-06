// Logger mínimo con marca de tiempo y nivel.
// Se mantiene simple a propósito: salida a stdout/stderr, que es lo que Railway captura.

function ts() {
  return new Date().toISOString();
}

export const logger = {
  info(msg, ...rest) {
    console.log(`[${ts()}] INFO  ${msg}`, ...rest);
  },
  warn(msg, ...rest) {
    console.warn(`[${ts()}] WARN  ${msg}`, ...rest);
  },
  error(msg, ...rest) {
    console.error(`[${ts()}] ERROR ${msg}`, ...rest);
  },
  debug(msg, ...rest) {
    if (process.env.DEBUG) {
      console.log(`[${ts()}] DEBUG ${msg}`, ...rest);
    }
  },
};
